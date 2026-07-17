"""Redis connection helpers for pub/sub.

Two use cases:
- **FastAPI / WebSocket** (Steps 2+): create one async client at app startup,
  store it on ``app.state.redis``, and close it on shutdown.
- **Celery polling task**: create a short-lived async client inside each
  ``asyncio.run()`` call, then close it when the run completes.

Channel naming:  ``showtime:{showtime_uuid}``
Snapshot key:    ``snapshot:{showtime_uuid}``

The snapshot is a JSON-serialised ``{seat_key: status}`` dict that the
polling task reads and writes to detect ``Occupied → Available`` transitions
without querying the Cineplex API a second time.
"""

import json
import uuid
from datetime import datetime, timezone

import redis.asyncio as aioredis
import structlog

from app.config import settings

log = structlog.get_logger()

# TTL for per-showtime availability snapshots stored in Redis (6 hours).
SNAPSHOT_TTL_SEC = 6 * 3600


# ---------------------------------------------------------------------------
# Channel / key naming
# ---------------------------------------------------------------------------


def make_channel(showtime_uuid: str) -> str:
    """Redis pub/sub channel for a showtime's seat-change events.

    All consumers interested in a specific showtime subscribe to this channel.
    The polling task publishes here whenever a seat flips to Available.
    """
    return f"showtime:{showtime_uuid}"


def make_snapshot_key(showtime_uuid: str) -> str:
    """Redis key for the last-known full availability snapshot of a showtime.

    Stored as a JSON string of ``{seat_key: "Available" | "Occupied"}``.
    The polling task reads this to diff the latest Cineplex response against.
    """
    return f"snapshot:{showtime_uuid}"


# ---------------------------------------------------------------------------
# Client factory
# ---------------------------------------------------------------------------


def create_async_redis() -> aioredis.Redis:
    """Create a new async Redis client.

    The caller is responsible for calling ``await r.aclose()`` when done.
    Pass ``decode_responses=True`` so all Redis values come back as strings
    (not bytes), which avoids manual ``.decode()`` calls everywhere.
    """
    return aioredis.from_url(settings.redis_url, decode_responses=True)


# ---------------------------------------------------------------------------
# Pub/sub publish helper
# ---------------------------------------------------------------------------


async def publish_seat_event(
    r: aioredis.Redis,
    *,
    showtime_uuid: str,
    theatre_id: int,
    showtime_id: int,
    seat_key: str,
    seat_label: str,
) -> None:
    """Publish a ``seat_available`` event to the showtime's pub/sub channel.

    Payload schema::

        {
            "type":          "seat_available",
            "showtime_uuid": str,    # our internal UUID PK
            "theatre_id":    int,    # Cineplex integer ID
            "showtime_id":   int,    # Cineplex integer ID
            "seat_key":      str,    # e.g. "1_7_4"
            "seat_label":    str,    # e.g. "G4"
            "detected_at":   str,    # ISO-8601 UTC timestamp
        }

    Consumers (WebSocket handler, notification task) subscribe to the channel
    and receive this payload as a JSON string.
    """
    channel = make_channel(showtime_uuid)
    payload = json.dumps(
        {
            "type": "seat_available",
            "showtime_uuid": showtime_uuid,
            "theatre_id": theatre_id,
            "showtime_id": showtime_id,
            "seat_key": seat_key,
            "seat_label": seat_label,
            "detected_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    await r.publish(channel, payload)
    await log.ainfo(
        "seat_event_published",
        channel=channel,
        seat_key=seat_key,
        seat_label=seat_label,
    )


# ---------------------------------------------------------------------------
# Single-flight poll lock
# ---------------------------------------------------------------------------
#
# Celery beat fires the poll task every 30 s, but a full poll cycle can take
# longer than that (~40-90 s at ~100 showtimes). On the 2-process prefork
# worker pool this means two (or more) cycles would otherwise run
# concurrently — duplicating every upstream Cineplex request and opening a
# narrow window where two cycles both decide a seat is newly-available and
# both send a notification (``watched_seats.notified_at`` is only stamped
# *after* the send). This lock makes the cycle single-flight: at most one runs
# at a time; any beat tick that fires while a cycle is in progress acquires
# nothing and skips.

POLL_LOCK_KEY = "lock:poll_seats"

# The lock auto-expires after this many seconds so a worker that crashes
# mid-cycle (without releasing) can't wedge polling forever. It MUST exceed the
# worst-case cycle duration — otherwise the lock would lapse mid-cycle and let
# a second cycle start, defeating the purpose. Current worst case is ~90 s;
# 300 s leaves generous headroom. (Once bounded-concurrency polling lands and
# cycle time drops to ~10 s, this could safely be lowered.)
POLL_LOCK_TTL_SEC = 300

# Ownership-safe release: only delete the lock if the stored token still
# matches ours. Without this compare-and-delete, a cycle that overran the TTL
# (so its lock already expired and was re-acquired by a newer cycle) could
# delete the *newer* cycle's lock on its way out. Running it as a Lua script
# keeps the GET + DEL atomic on the Redis server.
_RELEASE_LOCK_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""


async def acquire_poll_lock(r: aioredis.Redis) -> str | None:
    """Try to acquire the global single-flight poll lock (non-blocking).

    Returns a unique token if the lock was acquired, or ``None`` if another
    cycle already holds it. Built on ``SET key token NX EX ttl`` — Redis's
    canonical distributed-lock primitive: atomically set the key *only if it
    does not exist* (``NX``) and attach an expiry (``EX``) in one round trip.
    The returned token must be passed back to :func:`release_poll_lock`.
    """
    token = uuid.uuid4().hex
    acquired = await r.set(POLL_LOCK_KEY, token, nx=True, ex=POLL_LOCK_TTL_SEC)
    return token if acquired else None


async def release_poll_lock(r: aioredis.Redis, token: str) -> None:
    """Release the poll lock iff we still own it (token match).

    A failed release is non-fatal: the lock's TTL guarantees it is eventually
    freed regardless, so we log and swallow rather than propagate (which would
    otherwise mask the real outcome of the poll cycle).
    """
    try:
        await r.eval(_RELEASE_LOCK_LUA, 1, POLL_LOCK_KEY, token)
    except Exception as exc:  # pragma: no cover - defensive
        await log.awarning("poll_lock_release_failed", error=str(exc))
