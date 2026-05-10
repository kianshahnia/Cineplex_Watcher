"""WebSocket router — real-time seat availability updates via Redis pub/sub.

Clients connect to ``/ws/{showtime_uuid}`` and receive JSON messages whenever
the Celery polling task detects a seat status change for that showtime.

Connection lifecycle
--------------------
1. **Authenticate** via ``session_token`` cookie (auto-sent by browsers) or
   ``?token=<jwt>`` query parameter (useful for non-browser testing tools).
2. **Validate** that the showtime exists and is still active.
3. **Accept** the WebSocket and send a ``{"type": "connected"}`` confirmation.
4. **Subscribe** to the showtime's Redis pub/sub channel.
5. **Two concurrent async tasks** run until one finishes:
   - ``_forward_redis_messages``: reads from Redis pub/sub, sends to client.
   - ``_receive_client_messages``: reads from client to detect disconnect.
6. When either task ends (client disconnect, Redis error, etc.) the other is
   cancelled and the Redis subscription is cleaned up.

Why two tasks?
--------------
``pubsub.listen()`` is a blocking async iterator — it yields only when a
message arrives.  If the client disconnects while we're blocked waiting for
the next Redis message, we'd never notice until the *next* publish.  The
receive task detects the close frame immediately so we can tear down the
subscription without delay.
"""

import asyncio
import json
import uuid

import jwt as pyjwt
import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.models.showtime import Showtime
from app.services.redis_client import make_channel

log = structlog.get_logger()

router = APIRouter()

# Custom WebSocket close codes (4000–4999 is the application-use range).
WS_CLOSE_NOT_AUTHENTICATED = 4001
WS_CLOSE_SHOWTIME_NOT_FOUND = 4003


# ---------------------------------------------------------------------------
# Auth helper — WebSocket-specific (avoids HTTPException)
# ---------------------------------------------------------------------------


def _authenticate_ws(websocket: WebSocket) -> uuid.UUID | None:
    """Extract and validate the JWT from the WebSocket handshake.

    Reads the ``session_token`` cookie first (set by ``POST /auth/verify``
    as an httpOnly cookie).  Falls back to a ``token`` query parameter so
    tools like ``websocat`` or Postman can authenticate without cookies.

    Returns the user's UUID, or ``None`` if authentication fails.  Unlike
    ``services.auth.get_current_user``, this function never raises — the
    caller decides how to reject the connection.
    """
    token = (
        websocket.cookies.get("session_token")
        or websocket.query_params.get("token")
    )
    if not token:
        return None
    try:
        payload = pyjwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
        )
        sub = payload.get("sub")
        return uuid.UUID(sub) if sub else None
    except (pyjwt.InvalidTokenError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Concurrent tasks
# ---------------------------------------------------------------------------


async def _forward_redis_messages(pubsub, websocket: WebSocket) -> None:
    """Read from Redis pub/sub and forward each seat event to the client.

    ``pubsub.listen()`` yields dicts with a ``type`` field.  We only care
    about ``"message"`` (actual published data); subscription confirmations
    and unsubscription notices are silently skipped.  The ``data`` value is
    already a JSON string (published by ``publish_seat_event`` in the Celery
    task), so we send it directly — no extra serialisation step.
    """
    async for message in pubsub.listen():
        if message["type"] == "message":
            await websocket.send_text(message["data"])


async def _receive_client_messages(websocket: WebSocket) -> None:
    """Read from the WebSocket until the client disconnects.

    The client is not expected to send meaningful data — this task exists
    solely to receive the close frame so we can tear down the Redis
    subscription promptly instead of waiting for the next publish.
    """
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/ws/{showtime_uuid}")
async def ws_showtime(websocket: WebSocket, showtime_uuid: uuid.UUID) -> None:
    """Stream real-time seat events for a showtime.

    **Messages from server** (JSON strings):

    ``{"type": "connected", "showtime_uuid": "..."}``
        Sent once, immediately after the subscription is live.

    ``{"type": "seat_available", "showtime_uuid": "...", "theatre_id": ..., ...}``
        Published by the Celery poller whenever a seat flips ``Occupied →
        Available``.  See ``services.redis_client.publish_seat_event`` for the
        full schema.

    **Close codes**:
        4001 — not authenticated,
        4003 — showtime not found or inactive.
    """
    # ── 1. Authenticate ──────────────────────────────────────────────────
    user_id = _authenticate_ws(websocket)
    if user_id is None:
        await websocket.close(
            code=WS_CLOSE_NOT_AUTHENTICATED,
            reason="Not authenticated",
        )
        return

    # ── 2. Validate showtime ─────────────────────────────────────────────
    async with async_session_factory() as db:
        result = await db.execute(
            select(Showtime.id).where(
                Showtime.id == showtime_uuid,
                Showtime.is_active.is_(True),
            )
        )
        if result.scalar_one_or_none() is None:
            await websocket.close(
                code=WS_CLOSE_SHOWTIME_NOT_FOUND,
                reason="Showtime not found or inactive",
            )
            return

    # ── 3. Accept and confirm ────────────────────────────────────────────
    await websocket.accept()
    await log.ainfo(
        "ws_connected",
        user_id=str(user_id),
        showtime_uuid=str(showtime_uuid),
    )
    await websocket.send_text(
        json.dumps({"type": "connected", "showtime_uuid": str(showtime_uuid)})
    )

    # ── 4. Subscribe to Redis channel ────────────────────────────────────
    channel = make_channel(str(showtime_uuid))
    pubsub = websocket.app.state.redis.pubsub()

    try:
        await pubsub.subscribe(channel)
    except Exception as exc:
        await log.awarning("redis_subscribe_failed", error=str(exc))
        await websocket.close(code=1011, reason="Service temporarily unavailable")
        try:
            await pubsub.aclose()
        except Exception:
            pass
        return

    # ── 5. Forward events until disconnect ───────────────────────────────
    forward_task = asyncio.create_task(_forward_redis_messages(pubsub, websocket))
    receive_task = asyncio.create_task(_receive_client_messages(websocket))

    try:
        # Wait until either task completes.  Normally _receive_client_messages
        # finishes first (client sends close frame).  If Redis drops, the
        # forward task finishes first with a ConnectionError.
        done, pending = await asyncio.wait(
            [forward_task, receive_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # Cancel whichever task is still running and wait for it to finish
        # so Python doesn't warn about a "Task was destroyed but is pending".
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        # Retrieve (and log) any exception from the finished task so Python
        # doesn't warn "exception was never retrieved".
        for task in done:
            if not task.cancelled() and (exc := task.exception()) is not None:
                await log.awarning(
                    "ws_task_error",
                    error=str(exc),
                    showtime_uuid=str(showtime_uuid),
                )
    finally:
        # ── 6. Clean up Redis subscription ───────────────────────────────
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
        except Exception:
            pass  # Connection may already be dead — nothing more we can do.
        await log.ainfo(
            "ws_disconnected",
            user_id=str(user_id),
            showtime_uuid=str(showtime_uuid),
        )
