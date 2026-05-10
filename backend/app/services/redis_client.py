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
