"""Sibling showtimes — the movie's *other* screenings on the same screen.

The theatrical endpoint we already call for metadata carries an
``alternativeShowtimes`` array: the same film's other showings, which is exactly
the row of time buttons Cineplex's own Seat Preview modal renders.  Surfacing it
is what lets a user paste one link and apply a seat selection across every
showing, instead of repeating the whole flow per time.

**Four properties of that array shape everything here** (verified live
2026-07-24, theatre 1409):

1. **Symmetric** — querying any member returns the others, always excluding
   itself.  There is no "canonical first showtime", so whichever link the user
   pasted can anchor the set.
2. **Day-scoped** — one set per calendar day.  Multi-day is not reachable from
   this endpoint, which is why the feature is same-day only.
3. **Scoped to one auditorium *and* one presentation format.**  Spider-Man at
   one theatre on one day splits into three independent sets (Aud 09 3D ·
   AVX 12 2D · AVX 12 3D).  Cineplex already enforces same-screen-only for us.
4. **Seat keys are therefore identical across a set** — 258 IDs, zero label
   mismatches across the four IMAX siblings tested.  Copying a selection is a
   literal key-for-key copy.

Property 4 holds *because of* property 3, and that is the whole safety argument.
Seat maps of *different* auditoriums **partially overlap** — Aud 09 (220 seats)
and AVX 12 (342 seats) share 138 keys, where the same key means a different
physical seat.  A copy across rooms would look perfectly healthy on the dashboard
while watching the wrong seat, which is worse than an error.  So the auditorium
equality check below is **guard 1**, kept even though the empirical invariant
already holds; fan-out adds an independent **guard 2** (every requested seat key
must exist in the target's availability map).

**Why fetch rather than read ``showtimes.metadata_json``.**  Metadata is resolved
once and permanently (``should_resolve()`` returns False as soon as
``movie_name`` is set), so a list persisted at resolution time would freeze on
first view and never pick up a showtime Cineplex adds later.  A short Redis cache
gives the cheapness without the staleness.

Like every other upstream client here, this **never raises**: an empty set is the
answer for a missing key, a 404, a network failure, or a film with only one
showing.  The switcher is simply absent, per the TMDB-carousel convention.
"""

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import structlog

from app.services import cineplex_theatrical
from app.services.cineplex_theatrical import (
    TheatricalOutcome,
    parse_aware_utc,
    parse_naive_local,
)

log = structlog.get_logger()

# Short TTL on purpose.  `seats_remaining` rides along and is volatile, so this
# is "cheap enough to reopen a watch page for free" rather than a real cache.
_CACHE_KEY_PREFIX = "alternatives"
_CACHE_TTL_SEC = 300

# A failure caches too, briefly — otherwise an expired showtime (a 404 that never
# resolves) would fire an upstream request on every page load.  Kept far shorter
# than a success so a transient blip clears fast rather than blanking the
# switcher for five minutes.  Mirrors the two-cooldown split in
# `showtime_metadata.py`, for the same reason.
_CACHE_TTL_FAILED_SEC = 60


@dataclass(frozen=True)
class AlternativeShowtime:
    """One sibling screening, normalized to the columns we would store it in."""

    showtime_id: int
    #: Aware UTC instant — scheduling math only, never displayed.
    showtime_at: datetime | None
    #: Naive theatre-local wall clock — the display value.
    showtime_local: datetime | None
    auditorium: str | None
    #: Soft hint from a cached payload, never truth.  Live availability comes
    #: from the seat endpoint; this is only good enough to tint a chip.
    seats_remaining: int | None
    is_sold_out: bool

    def to_cache(self) -> dict[str, Any]:
        """JSON-safe form.  Datetimes keep their awareness through isoformat."""
        return {
            "showtime_id": self.showtime_id,
            "showtime_at": self.showtime_at.isoformat() if self.showtime_at else None,
            "showtime_local": self.showtime_local.isoformat() if self.showtime_local else None,
            "auditorium": self.auditorium,
            "seats_remaining": self.seats_remaining,
            "is_sold_out": self.is_sold_out,
        }

    @classmethod
    def from_cache(cls, raw: dict[str, Any]) -> "AlternativeShowtime":
        return cls(
            showtime_id=raw["showtime_id"],
            # `fromisoformat` restores tz-awareness exactly as `isoformat` wrote
            # it: an offset for the UTC instant, none for the local wall clock.
            showtime_at=parse_aware_utc(raw.get("showtime_at")),
            showtime_local=parse_naive_local(raw.get("showtime_local")),
            auditorium=raw.get("auditorium"),
            seats_remaining=raw.get("seats_remaining"),
            is_sold_out=bool(raw.get("is_sold_out")),
        )


@dataclass(frozen=True)
class SiblingSet:
    """The anchor's identity plus its compatible siblings, ready to render."""

    theatre_id: int
    #: The anchor — the showtime whose link the user actually pasted.
    showtime_id: int
    #: Shared by the whole set (property 3).  The switcher header renders it.
    auditorium: str | None
    #: The anchor's local start; the set's shared day comes off its date.
    showtime_local: datetime | None
    alternatives: list[AlternativeShowtime]

    @classmethod
    def empty(cls, theatre_id: int, showtime_id: int) -> "SiblingSet":
        """The degrade-quietly answer: no switcher, no error."""
        return cls(
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            auditorium=None,
            showtime_local=None,
            alternatives=[],
        )

    def to_cache(self) -> dict[str, Any]:
        return {
            "auditorium": self.auditorium,
            "showtime_local": self.showtime_local.isoformat() if self.showtime_local else None,
            "alternatives": [alt.to_cache() for alt in self.alternatives],
        }

    @classmethod
    def from_cache(cls, theatre_id: int, showtime_id: int, raw: dict[str, Any]) -> "SiblingSet":
        return cls(
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            auditorium=raw.get("auditorium"),
            showtime_local=parse_naive_local(raw.get("showtime_local")),
            alternatives=[
                AlternativeShowtime.from_cache(item) for item in raw.get("alternatives") or []
            ],
        )


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


async def list_alternatives(theatre_id: int, showtime_id: int, redis) -> SiblingSet:
    """Return the sibling screenings of this showtime, or an empty set.

    Never raises.  An empty ``alternatives`` list is the honest answer for a film
    with a single showing *and* the degraded answer for every failure — the UI
    treats both identically (no switcher), so they need not be distinguished.
    """
    cached = await _read_cache(redis, theatre_id, showtime_id)
    if cached is not None:
        return cached

    result = await cineplex_theatrical.fetch_showtime(theatre_id, showtime_id, redis)

    if result.outcome is TheatricalOutcome.NO_KEY:
        # Unconfigured → the switcher is simply absent.  Not cached: the next
        # request should pick up a key the moment one is set.
        await log.ainfo("showtime_alternatives_skipped_no_key", theatre_id=theatre_id)
        return SiblingSet.empty(theatre_id, showtime_id)

    if not result.is_ok:
        await log.ainfo(
            "showtime_alternatives_unresolved",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            outcome=result.outcome.value,
            status_code=result.status_code,
        )
        empty = SiblingSet.empty(theatre_id, showtime_id)
        await _write_cache(redis, empty, ttl_sec=_CACHE_TTL_FAILED_SEC)
        return empty

    sibling_set = parse_alternatives(
        result.payload or {},
        theatre_id=theatre_id,
        showtime_id=showtime_id,
    )

    await log.ainfo(
        "showtime_alternatives_resolved",
        theatre_id=theatre_id,
        showtime_id=showtime_id,
        auditorium=sibling_set.auditorium,
        count=len(sibling_set.alternatives),
    )
    await _write_cache(redis, sibling_set, ttl_sec=_CACHE_TTL_SEC)
    return sibling_set


# ---------------------------------------------------------------------------
# Parsing + filtering
# ---------------------------------------------------------------------------


def parse_alternatives(
    payload: dict[str, Any],
    *,
    theatre_id: int,
    showtime_id: int,
    now: datetime | None = None,
) -> SiblingSet:
    """Normalize and filter ``alternativeShowtimes`` out of a theatrical payload.

    Pure function — no I/O — so the mapping and every filter can be verified
    against a saved response.  ``now`` is injectable for the same reason.

    Filters, and why each one drops an entry:

    ==============================  ==========================================
    Dropped when                    Reason
    ==============================  ==========================================
    already started                 Can't watch a screening that has begun.
    not enabled online              Not purchasable, so there is no seat map.
    not reserved seating            General admission has no seats to watch.
    different auditorium            **Guard 1** — see the module docstring.
    ==============================  ==========================================
    """
    anchor = payload.get("showtime") or {}
    anchor_auditorium = _clean_str(anchor.get("auditorium"))

    raw_list = payload.get("alternativeShowtimes")
    if not isinstance(raw_list, list):
        raw_list = []

    parsed: list[AlternativeShowtime] = []
    for raw in raw_list:
        alt = _parse_alternative(
            raw,
            anchor_showtime_id=showtime_id,
            anchor_auditorium=anchor_auditorium,
            now=now or datetime.now(timezone.utc),
        )
        if alt is not None:
            parsed.append(alt)

    # Ascending by local start.  `None` last rather than raising on a mixed
    # sort — a sibling we could not date is still worth listing.
    parsed.sort(key=lambda a: (a.showtime_local is None, a.showtime_local or datetime.min))

    return SiblingSet(
        theatre_id=theatre_id,
        showtime_id=showtime_id,
        auditorium=anchor_auditorium,
        showtime_local=parse_naive_local(anchor.get("showStartDateTime")),
        alternatives=parsed,
    )


def _parse_alternative(
    raw: Any,
    *,
    anchor_showtime_id: int,
    anchor_auditorium: str | None,
    now: datetime,
) -> AlternativeShowtime | None:
    """Normalize one entry, or return ``None`` if it must be dropped."""
    if not isinstance(raw, dict):
        return None

    sibling_id = raw.get("vistaSessionId")
    # `bool` is an `int` subclass, so exclude it explicitly — a stray `true`
    # would otherwise become showtime 1.
    if not isinstance(sibling_id, int) or isinstance(sibling_id, bool):
        return None

    # Defensive: the array excludes the anchor by construction (property 1), but
    # a self-entry would create a watch on the page the user is already on.
    if sibling_id == anchor_showtime_id:
        return None

    showtime_at = parse_aware_utc(raw.get("showStartDateTimeUtc"))

    # Trust the upstream flag, and fall back to the timestamp when it is absent —
    # the same "has it started?" rule the poller applies in `get_poll_interval`.
    if raw.get("isInThePast") is True:
        return None
    if showtime_at is not None and showtime_at <= now:
        return None

    # Missing capability flags are read as permissive rather than prohibitive: a
    # field we cannot see should not silently empty the switcher if Cineplex
    # renames it.  Fan-out's guard 2 independently rejects anything whose seat
    # map does not actually match, so a wrong guess here is caught downstream.
    if raw.get("isShowtimeEnabledOnline", True) is False:
        return None
    if raw.get("isReservedSeating", True) is False:
        return None

    auditorium = _clean_str(raw.get("auditorium"))
    if not _same_auditorium(anchor_auditorium, auditorium):
        # Loud: the empirical invariant (property 3) says this never fires.  If it
        # does, Cineplex changed the grouping semantics and the seat-key
        # compatibility assumption this feature rests on needs re-verifying.
        log.error(
            "sibling_auditorium_mismatch",
            anchor_auditorium=anchor_auditorium,
            sibling_auditorium=auditorium,
            sibling_showtime_id=sibling_id,
        )
        return None

    seats_remaining = raw.get("seatsRemaining")
    if isinstance(seats_remaining, bool) or not isinstance(seats_remaining, int):
        seats_remaining = None

    return AlternativeShowtime(
        showtime_id=sibling_id,
        showtime_at=showtime_at,
        showtime_local=parse_naive_local(raw.get("showStartDateTime")),
        auditorium=auditorium,
        seats_remaining=seats_remaining,
        is_sold_out=raw.get("isSoldOut") is True,
    )


def _same_auditorium(anchor: str | None, sibling: str | None) -> bool:
    """Guard 1: siblings must play in the anchor's room.

    When the anchor's auditorium is unknown there is nothing to compare against,
    so the guard abstains rather than rejecting everything.  Fan-out's guard 2
    (seat-key presence) is independent and still applies, which is exactly why
    two guards exist.
    """
    if anchor is None:
        return True
    if sibling is None:
        return False
    return anchor.strip().casefold() == sibling.strip().casefold()


def _clean_str(value: Any) -> str | None:
    """Trim and drop empties, preserving the upstream's own casing."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
#
# Every Redis interaction here fails **open**: a cache miss costs one upstream
# request, whereas failing closed would take the switcher down during a Redis
# blip.  Same posture as the metadata cooldown and the key scrape lock.


def _cache_key(theatre_id: int, showtime_id: int) -> str:
    return f"{_CACHE_KEY_PREFIX}:{theatre_id}:{showtime_id}"


async def _read_cache(redis, theatre_id: int, showtime_id: int) -> SiblingSet | None:
    """Return the cached set, or ``None`` on miss / unreadable cache."""
    try:
        cached = await redis.get(_cache_key(theatre_id, showtime_id))
    except Exception as exc:  # noqa: BLE001 — a Redis blip just bypasses the cache
        await log.awarning("showtime_alternatives_cache_read_failed", error=str(exc))
        return None
    if not cached:
        return None
    try:
        return SiblingSet.from_cache(theatre_id, showtime_id, json.loads(cached))
    except (json.JSONDecodeError, KeyError, TypeError):
        # A shape change from an older deploy — treat as a miss and refetch.
        return None


async def _write_cache(redis, sibling_set: SiblingSet, *, ttl_sec: int) -> None:
    """Store the *filtered* set.  Best-effort; a failure just means a refetch."""
    try:
        await redis.set(
            _cache_key(sibling_set.theatre_id, sibling_set.showtime_id),
            json.dumps(sibling_set.to_cache()),
            ex=ttl_sec,
        )
    except Exception as exc:  # noqa: BLE001 — caching must never fail the request
        await log.awarning("showtime_alternatives_cache_write_failed", error=str(exc))
