"""Resolve a showtime's real movie title, theatre, and start time from Cineplex.

This closes the project's longest-standing known gap: ``showtimes.movie_name``,
``theater_name`` and ``showtime_at`` have existed as columns since the first
migration and have always been NULL, because the two seat endpoints we use
return no metadata.  A *different* Cineplex API product does::

    GET /prod/cpx/theatrical/api/v1/theatres/{theatre_id}/showtimes/{showtime_id}

modelled on ``services/movies.py`` (the TMDB client), which is the closest
existing analogue: secret held server-side, cached, and — most importantly —
**never raises to the caller**.  A metadata failure must never break the seat
map, which is the actual product.

**The two timestamps.**  The response hands us both
``showStartDateTime`` (naive, theatre-local wall clock) and
``showStartDateTimeUtc`` (aware UTC instant), and we store both:

* the **instant** (``showtimes.showtime_at``) feeds poll-interval math, which
  needs to compare against ``now()``;
* the **wall clock** (``showtimes.showtime_local``) feeds everything a user
  reads — emails, the watch header, the dashboard.

Keeping both is what lets us render "11:00 AM" for a Vancouver screening without
ever deriving a theatre's timezone.  Cineplex spans BC to Newfoundland, so a
single stored instant plus a guessed timezone would be wrong for most users.

**Failure handling is the interesting part.**  "Resolve once, cache forever" is
correct for *successes* — a showtimeId's title and start time are immutable — but
caching a *failure* forever would poison a showtime on one transient blip, and
retrying on every page view would hammer upstream.  So:

============================  ==========================================
State                         Behaviour
============================  ==========================================
``movie_name`` set            Never re-fetch.  Permanent.
``metadata_fetched_at`` NULL  Resolve now (never tried).
Failed — 404                  Redis cooldown, long (expired showtimes are
                              the common case, and they never come back).
Failed — transient            Redis cooldown, short.
============================  ==========================================

The cooldown lives in Redis rather than a DB column precisely because it should
expire on its own — no cleanup job, and no schema change to tune it.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.showtime import Showtime
from app.services import cineplex_key

log = structlog.get_logger()

# Note this is a DIFFERENT API product path from `cineplex.CINEPLEX_API_BASE`
# (`/prod/ticketing/…`): same host and same Imperva front door, but with an
# Azure APIM subscription gate on top.  Hence the separate constant and the
# separate key manager.
CINEPLEX_THEATRICAL_API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1"

_USER_AGENT = "Cinewatch/1.0 (+https://cinewatch.ca)"

# Deliberately short.  This call happens inline in the server-side render of the
# watch page, so a slow upstream would show up directly as a slow page load.
# Better to skip metadata for one view than to hold the seat map hostage.
_REQUEST_TIMEOUT_SEC = 6.0

_COOLDOWN_KEY_PREFIX = "cooldown:showtime_metadata"
# A 404 means Cineplex does not know this theatre+showtime pair — almost always
# a screening that has aged out of their system.  That does not un-happen, so
# back off hard.
_COOLDOWN_NOT_FOUND_SEC = 24 * 3600
# Network error, 5xx, or an unusable 200 — retry soon, but not on every view.
_COOLDOWN_TRANSIENT_SEC = 600

# `showtimes.movie_name` / `theater_name` are VARCHAR(255).  Cineplex titles run
# long ("… : The IMAX Experience® in 70MM Film"), so clamp rather than let an
# outlier raise a DataError at commit time and lose the whole resolution.
_NAME_MAX_LEN = 255


@dataclass(frozen=True)
class ResolvedMetadata:
    """Normalized, ready-to-persist view of the upstream response.

    A typed dataclass rather than a bare dict (matching ``RenderedEmail`` in
    ``services/notifications.py``) because the two datetimes have *different*
    tz-awareness by design, and a dict would make that trivially easy to mix up
    at the call site.
    """

    movie_name: str | None
    theater_name: str | None
    #: Aware UTC instant — compare against ``now()``, never display directly.
    showtime_at: datetime | None
    #: Naive theatre-local wall clock — display this, never compare it.
    showtime_local: datetime | None
    #: Trimmed extras (posters, runtime, rating, genres…).  Nothing renders them
    #: yet; captured now so a later feature needs no migration.
    metadata_json: dict[str, Any] = field(default_factory=dict)

    @property
    def is_usable(self) -> bool:
        """True if the response carried anything worth writing to the row."""
        return bool(self.movie_name or self.theater_name or self.showtime_local)


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------


def should_resolve(showtime: Showtime) -> bool:
    """Whether this row is worth a resolution attempt right now.

    Encodes the "permanent for successes, retryable for failures" half of the
    policy; the Redis cooldown inside :func:`resolve_showtime_metadata` enforces
    the rate half.  Split that way so a caller can skip the whole code path (and
    the Redis round trip) for the overwhelmingly common already-resolved case.
    """
    return showtime.movie_name is None


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


async def resolve_showtime_metadata(
    theatre_id: int,
    showtime_id: int,
    redis,
) -> ResolvedMetadata | None:
    """Fetch and normalize metadata for one showtime, or return ``None``.

    Never raises.  ``None`` means "no metadata this time" for any reason: the
    feature is unconfigured, we are inside a cooldown, the pair is unknown
    upstream, or the request failed.  Callers should treat it as a non-event.
    """
    if await _in_cooldown(redis, theatre_id, showtime_id):
        return None

    key = await cineplex_key.get_api_key(redis)
    if not key:
        # No key configured → dev-mode no-op, same as TMDB / Resend / Twilio.
        await log.ainfo("showtime_metadata_skipped_no_key", theatre_id=theatre_id)
        return None

    try:
        async with httpx.AsyncClient(
            timeout=_REQUEST_TIMEOUT_SEC,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            resp = await _request_metadata(client, theatre_id, showtime_id, key)

            if resp.status_code == 401:
                resp = await _retry_with_refreshed_key(
                    client,
                    redis,
                    theatre_id,
                    showtime_id,
                    failed_key=key,
                )
                if resp is None:
                    await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_TRANSIENT_SEC)
                    return None

            if resp.status_code == 404:
                # Not an error: an expired or mistyped showtime is a normal
                # thing for a user to paste.
                await log.ainfo(
                    "showtime_metadata_not_found",
                    theatre_id=theatre_id,
                    showtime_id=showtime_id,
                )
                await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_NOT_FOUND_SEC)
                return None

            if resp.status_code != 200:
                await log.awarning(
                    "showtime_metadata_non_200",
                    theatre_id=theatre_id,
                    showtime_id=showtime_id,
                    status_code=resp.status_code,
                )
                await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_TRANSIENT_SEC)
                return None

            payload = resp.json()
    except httpx.HTTPError as exc:
        await log.awarning(
            "showtime_metadata_request_failed",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            error=str(exc),
        )
        await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_TRANSIENT_SEC)
        return None
    except ValueError as exc:  # resp.json() on a non-JSON body
        await log.awarning(
            "showtime_metadata_bad_json",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            error=str(exc),
        )
        await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_TRANSIENT_SEC)
        return None

    resolved = parse_metadata_response(payload)
    if not resolved.is_usable:
        # A 200 that carries nothing we can store.  Treat as transient — the
        # shape may have changed, and hammering it won't help.
        await log.awarning(
            "showtime_metadata_empty",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
        )
        await _set_cooldown(redis, theatre_id, showtime_id, _COOLDOWN_TRANSIENT_SEC)
        return None

    await log.ainfo(
        "showtime_metadata_resolved",
        theatre_id=theatre_id,
        showtime_id=showtime_id,
        movie_name=resolved.movie_name,
        showtime_local=resolved.showtime_local.isoformat() if resolved.showtime_local else None,
    )
    return resolved


async def _request_metadata(
    client: httpx.AsyncClient,
    theatre_id: int,
    showtime_id: int,
    key: str,
) -> httpx.Response:
    """One GET against the theatrical endpoint.  Status handling is the caller's."""
    url = f"{CINEPLEX_THEATRICAL_API_BASE}/theatres/{theatre_id}/showtimes/{showtime_id}"
    return await client.get(url, headers={"Ocp-Apim-Subscription-Key": key})


async def _retry_with_refreshed_key(
    client: httpx.AsyncClient,
    redis,
    theatre_id: int,
    showtime_id: int,
    *,
    failed_key: str,
) -> httpx.Response | None:
    """Re-scrape the key and retry, returning the first non-401 response.

    The retry **is** the validation: there is no way to tell a good key from a
    stale one by inspection, and the bundle legitimately contains more than one
    valid key plus a placeholder.  A non-401 (including a 404 for an unknown
    pair) proves the subscription gate accepted the key, so it is stored for
    every other worker to use.

    Returns ``None`` when no candidate worked — the caller must not loop.
    """
    candidates = await cineplex_key.refresh_candidates(redis, failed_key=failed_key)
    for candidate in candidates:
        resp = await _request_metadata(client, theatre_id, showtime_id, candidate)
        if resp.status_code != 401:
            await cineplex_key.store_api_key(redis, candidate)
            await log.awarning("cineplex_key_refreshed", tried=len(candidates))
            return resp

    # ERROR, not warning: the metadata feature is now fully dark until someone
    # intervenes.  This is the same class of alarm as the upstream-403 canary —
    # wire it into alerting alongside it.
    await log.aerror("cineplex_key_refresh_failed", candidates=len(candidates))
    return None


# ---------------------------------------------------------------------------
# Failure cooldown
# ---------------------------------------------------------------------------
#
# Without this, an unresolvable showtime would fire an upstream request on every
# single page view of its watch page.  The row-level guard (`should_resolve`)
# can't cover it: a failed attempt leaves `movie_name` NULL, so the row stays
# forever "worth trying".  A self-expiring Redis key is the whole mechanism —
# there is nothing to clean up and nothing to migrate when the durations change.


def _cooldown_key(theatre_id: int, showtime_id: int) -> str:
    return f"{_COOLDOWN_KEY_PREFIX}:{theatre_id}:{showtime_id}"


async def _in_cooldown(redis, theatre_id: int, showtime_id: int) -> bool:
    """Whether a recent attempt for this pair failed and we should hold off.

    Fails **open** (returns ``False``) if Redis is unreachable: losing the
    cooldown costs a few redundant upstream requests, whereas failing closed
    would disable metadata resolution entirely during a Redis blip.
    """
    try:
        return await redis.exists(_cooldown_key(theatre_id, showtime_id)) > 0
    except Exception as exc:  # noqa: BLE001 — see docstring: fail open
        await log.awarning("showtime_metadata_cooldown_read_failed", error=str(exc))
        return False


async def _set_cooldown(redis, theatre_id: int, showtime_id: int, ttl_sec: int) -> None:
    """Suppress retries for this pair for ``ttl_sec`` seconds.  Best-effort."""
    try:
        await redis.set(_cooldown_key(theatre_id, showtime_id), "1", ex=ttl_sec)
    except Exception as exc:  # noqa: BLE001 — a missing cooldown is not fatal
        await log.awarning("showtime_metadata_cooldown_write_failed", error=str(exc))


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_metadata_response(payload: dict[str, Any]) -> ResolvedMetadata:
    """Normalize the upstream JSON into the shape our columns want.

    Pure function — no I/O — so the mapping can be verified against a saved
    response.  Every field is optional: a missing or null key yields ``None``
    rather than raising, because a partially-usable response still beats none.
    """
    showtime_block = payload.get("showtime") or {}
    return ResolvedMetadata(
        # `or None` rather than `.get(k, None)`: Cineplex returns explicit nulls
        # and empty strings, and `.get`'s default only covers a *missing* key.
        # This is the same trap that broke `merge_layout_and_availability` on
        # null row labels — see services/cineplex.py.
        movie_name=_clean_name(payload.get("movie")),
        theater_name=_clean_name(payload.get("theatre")),
        showtime_at=_parse_aware_utc(showtime_block.get("showStartDateTimeUtc")),
        showtime_local=_parse_naive_local(showtime_block.get("showStartDateTime")),
        metadata_json=_trim_metadata(payload),
    )


def _trim_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep the free extras worth storing; drop the bulk and the volatile.

    Dropped deliberately:

    * ``alternativeShowtimes`` — large, and a different feature ("watch another
      screening of this film") that would want fresh data anyway;
    * ``location`` as a block — it carries ``distanceToOriginInMeters``, which
      is computed from the *caller's* IP and so is meaningless once cached.  The
      two static facts in it (city, province) are kept;
    * ``seatsRemaining`` / ``isSoldOut`` — these change minute to minute, and
      this blob is written once and never refreshed.  Storing them would be
      storing a lie.  Live availability already comes from the seat endpoint.
    * ``showDate`` — midnight of the screening day, not the screening time.
      Superseded by the two real timestamps.
    """
    showtime_block = payload.get("showtime") or {}
    location = payload.get("location") or {}
    return {
        "movie_id": payload.get("movieId"),
        "poster_small_url": payload.get("smallPosterImageUrl") or None,
        "poster_medium_url": payload.get("mediumPosterImageUrl") or None,
        "poster_large_url": payload.get("largePosterImageUrl") or None,
        "runtime_minutes": payload.get("runtimeInMinutes"),
        "rating": payload.get("localRating") or None,
        "genres": payload.get("genres") or [],
        "experience_types": payload.get("experienceTypes") or [],
        "warnings": payload.get("warnings") or [],
        "language": payload.get("language") or None,
        "distributor": payload.get("distributor") or None,
        "auditorium": showtime_block.get("auditorium") or None,
        "theatre_city": location.get("city") or None,
        "theatre_province": location.get("provinceCode") or None,
    }


def _clean_name(value: Any) -> str | None:
    """Trim, drop empties, and clamp to the column width."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned[:_NAME_MAX_LEN]


def _parse_aware_utc(value: Any) -> datetime | None:
    """Parse ``2026-07-25T18:00:00Z`` into an aware UTC datetime.

    Python 3.11+ accepts the trailing ``Z`` in ``fromisoformat``; the explicit
    ``tzinfo`` fallback covers an offset-less value, which would otherwise land
    in ``showtime_at`` as naive and silently break every ``now() -`` comparison
    that column exists to serve.
    """
    parsed = _parse_iso(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_naive_local(value: Any) -> datetime | None:
    """Parse ``2026-07-25T11:00:00`` into a *naive* datetime.

    Any offset is stripped rather than converted: this value is a theatre-local
    wall clock destined for a ``TIMESTAMP WITHOUT TIME ZONE`` column, and
    normalizing it to UTC is exactly the bug we are storing two columns to
    avoid.  Mirrors ``_clean_showtime_at`` in ``schemas/watches.py``.
    """
    parsed = _parse_iso(value)
    if parsed is None:
        return None
    return parsed.replace(tzinfo=None)


def _parse_iso(value: Any) -> datetime | None:
    """Best-effort ISO-8601 parse that returns ``None`` instead of raising."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip())
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


async def persist_showtime_metadata(
    showtime: Showtime,
    resolved: ResolvedMetadata | None,
    db: AsyncSession,
) -> None:
    """Write a resolution attempt to the ``showtimes`` row and commit.

    ``metadata_fetched_at`` is stamped on **every** attempt, success or failure —
    that stamp alongside a still-NULL ``movie_name`` is what marks a row as
    "tried and failed" rather than "never tried".  Pass ``resolved=None`` on
    failure to record the attempt without touching the data columns.

    Individual fields are only overwritten when the new value is non-NULL, so a
    partially-successful resolution can never blank out a column an earlier one
    filled in.
    """
    showtime.metadata_fetched_at = datetime.now(timezone.utc)

    if resolved is not None:
        if resolved.movie_name:
            showtime.movie_name = resolved.movie_name
        if resolved.theater_name:
            showtime.theater_name = resolved.theater_name
        if resolved.showtime_at:
            showtime.showtime_at = resolved.showtime_at
        if resolved.showtime_local:
            showtime.showtime_local = resolved.showtime_local
        if resolved.metadata_json:
            showtime.metadata_json = resolved.metadata_json

    await db.commit()
    await db.refresh(showtime)


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------


async def ensure_showtime_metadata(showtime: Showtime, redis, db: AsyncSession) -> bool:
    """Resolve + persist this showtime's metadata if it still needs it.

    The single entry point for callers — the seat-map endpoint and the backfill
    script both use this so the guard order can never drift between them.
    Returns ``True`` only when this call actually filled something in.

    **Never raises.**  Metadata is an enhancement; the seat map is the product.
    A failure here — upstream, Redis, or database — must degrade to the old
    "Your watched showtime" placeholder, never to a 500 on the watch page.

    The cooldown is re-checked here (``resolve_showtime_metadata`` checks it too)
    so that a row inside its cooldown costs one Redis ``EXISTS`` and nothing
    else.  Without this the persist below would still run and stamp
    ``metadata_fetched_at``, meaning a database write on *every page view* of an
    unresolvable showtime for the whole 24 h window.
    """
    if not should_resolve(showtime):
        return False
    if await _in_cooldown(redis, showtime.theatre_id, showtime.showtime_id):
        return False

    resolved = await resolve_showtime_metadata(
        showtime.theatre_id, showtime.showtime_id, redis
    )

    try:
        # Runs even when `resolved` is None: the point of the stamp is to record
        # that we *tried*, which is what separates "never attempted" from
        # "attempted and failed" on the row.
        await persist_showtime_metadata(showtime, resolved, db)
    except SQLAlchemyError as exc:
        # Rollback matters beyond this function: the caller keeps using this
        # session (the seat-map handler commits again a few lines later), and a
        # session left in an errored state fails every subsequent statement.
        await db.rollback()
        await log.awarning(
            "showtime_metadata_persist_failed",
            theatre_id=showtime.theatre_id,
            showtime_id=showtime.showtime_id,
            error=str(exc),
        )
        return False

    return resolved is not None
