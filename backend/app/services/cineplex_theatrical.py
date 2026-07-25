"""Shared transport for Cineplex's *theatrical* API product.

One endpoint now has two consumers:

* ``services/showtime_metadata.py`` — reads the movie title, theatre, and the
  two start timestamps off the top level of the response;
* ``services/showtime_alternatives.py`` — reads the ``alternativeShowtimes``
  array off the *same* response.

Both call::

    GET /prod/cpx/theatrical/api/v1/theatres/{theatre_id}/showtimes/{showtime_id}

which is a different API product from the seat endpoints (``/prod/ticketing/…``,
see ``services/cineplex.py``): same host and same Imperva front door, but with an
Azure APIM subscription gate on top that needs an ``Ocp-Apim-Subscription-Key``
header.  Managing that key — discovery, storage, and the self-heal on rotation —
is ``services/cineplex_key.py``'s job.

**This module exists so that key story stays single.**  The request, the 401
detection, and the retry-with-refreshed-key loop used to live inside
``showtime_metadata.py``; a second copy in the alternatives service would mean a
key rotation self-heals through one path and not the other, and the two would
drift.  Everything here is transport — no caching, no cooldowns, no persistence.
Those policies differ per consumer and stay with the consumer.

**Status handling is returned, not decided.**  A 404 means "expired showtime" to
the metadata resolver (back off for a day) and "no sibling list" to the
alternatives service (fall back to no switcher).  So this module classifies the
outcome and hands it back rather than picking a reaction — the caller owns the
policy.  Like every other upstream client in this codebase, it **never raises**.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import httpx
import structlog

from app.services import cineplex_key

log = structlog.get_logger()

# Note the `/cpx/theatrical/` path segment — deliberately NOT the same base as
# `cineplex.CINEPLEX_API_BASE` (`/prod/ticketing/…`), which needs no key.
CINEPLEX_THEATRICAL_API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1"

# Honest app identifier rather than a spoofed browser UA — Cineplex's WAF filters
# on IP reputation (proven during the Hetzner→OVH migration), so a fake browser
# string buys nothing and an accurate one is good-citizen behaviour.
_USER_AGENT = "Cinewatch/1.0 (+https://cinewatch.ca)"

# Deliberately short: both consumers are called inline from a request that a user
# is waiting on (the watch page's server-side render).  Better to skip the
# enhancement for one view than to hold the seat map hostage to a slow upstream.
DEFAULT_TIMEOUT_SEC = 6.0


class TheatricalOutcome(Enum):
    """Why a fetch ended the way it did.

    Split finer than "worked / didn't" because the callers back off differently:
    ``NOT_FOUND`` is durable (an aged-out showtime never comes back) while
    ``ERROR`` is transient, and ``NO_KEY`` is a configuration state rather than a
    failure at all — it must not be treated as something to retry.
    """

    OK = "ok"
    #: No subscription key configured or discoverable — the feature is off.
    NO_KEY = "no_key"
    #: Upstream does not know this theatre+showtime pair.
    NOT_FOUND = "not_found"
    #: 401 survived the self-heal; every candidate key was rejected.
    UNAUTHORIZED = "unauthorized"
    #: Network failure, unexpected status, or an unparseable body.
    ERROR = "error"


@dataclass(frozen=True)
class TheatricalResult:
    """Outcome of one fetch, with the payload when there is one."""

    outcome: TheatricalOutcome
    payload: dict[str, Any] | None = None
    status_code: int | None = None
    #: Human-readable cause, set on ``ERROR`` — carried so the caller can log it
    #: without this module deciding at what level it deserves to be logged.
    detail: str | None = None

    @property
    def is_ok(self) -> bool:
        return self.outcome is TheatricalOutcome.OK and self.payload is not None


async def fetch_showtime(
    theatre_id: int,
    showtime_id: int,
    redis,
    *,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
) -> TheatricalResult:
    """Fetch one showtime's theatrical record, self-healing a rotated key.

    Never raises.  Every failure mode comes back as a :class:`TheatricalResult`
    with a non-``OK`` outcome, so callers can branch on policy without a
    try/except around the call.
    """
    key = await cineplex_key.get_api_key(redis)
    if not key:
        # Blank key → dev-mode no-op, the same convention as the Resend / Twilio
        # / TMDB integrations.  Not an error: the feature is simply unconfigured.
        return TheatricalResult(TheatricalOutcome.NO_KEY)

    try:
        async with httpx.AsyncClient(
            timeout=timeout_sec,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            resp = await _request(client, theatre_id, showtime_id, key)

            if resp.status_code == 401:
                resp = await _retry_with_refreshed_key(
                    client,
                    redis,
                    theatre_id,
                    showtime_id,
                    failed_key=key,
                )
                if resp is None:
                    return TheatricalResult(
                        TheatricalOutcome.UNAUTHORIZED,
                        status_code=401,
                        detail="no subscription key candidate was accepted",
                    )

            if resp.status_code == 404:
                return TheatricalResult(TheatricalOutcome.NOT_FOUND, status_code=404)

            if resp.status_code != 200:
                await log.awarning(
                    "cineplex_theatrical_non_200",
                    theatre_id=theatre_id,
                    showtime_id=showtime_id,
                    status_code=resp.status_code,
                )
                return TheatricalResult(
                    TheatricalOutcome.ERROR,
                    status_code=resp.status_code,
                    detail=f"upstream returned {resp.status_code}",
                )

            payload = resp.json()
    except httpx.HTTPError as exc:
        await log.awarning(
            "cineplex_theatrical_request_failed",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            error=str(exc),
        )
        return TheatricalResult(TheatricalOutcome.ERROR, detail=str(exc))
    except ValueError as exc:  # resp.json() on a non-JSON body
        await log.awarning(
            "cineplex_theatrical_bad_json",
            theatre_id=theatre_id,
            showtime_id=showtime_id,
            error=str(exc),
        )
        return TheatricalResult(TheatricalOutcome.ERROR, status_code=200, detail=str(exc))

    if not isinstance(payload, dict):
        # A 200 whose body is a list or scalar.  Defensive rather than expected:
        # every consumer indexes into this by key.
        return TheatricalResult(
            TheatricalOutcome.ERROR,
            status_code=200,
            detail=f"expected a JSON object, got {type(payload).__name__}",
        )

    return TheatricalResult(TheatricalOutcome.OK, payload=payload, status_code=200)


async def _request(
    client: httpx.AsyncClient,
    theatre_id: int,
    showtime_id: int,
    key: str,
) -> httpx.Response:
    """One GET against the theatrical endpoint.  Status handling is the caller's."""
    url = f"{CINEPLEX_THEATRICAL_API_BASE}/theatres/{theatre_id}/showtimes/{showtime_id}"
    return await client.get(url, headers={"Ocp-Apim-Subscription-Key": key})


# ---------------------------------------------------------------------------
# Shared payload conventions
# ---------------------------------------------------------------------------
#
# This API states every screening time TWICE — as an aware UTC instant and as a
# naive theatre-local wall clock — and both consumers need both, for opposite
# purposes.  The pair maps onto the `showtime_at` / `showtime_local` column split
# it motivated: the instant feeds poll-interval math that compares against
# `now()`; the wall clock feeds everything a user reads.
#
# Keeping one copy of these parsers is what stops the two services from
# disagreeing about which value is which.  Cineplex spans BC to Newfoundland, so
# collapsing to a single stored instant plus a guessed timezone would render the
# wrong hour for most users.


def parse_aware_utc(value: Any) -> datetime | None:
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


def parse_naive_local(value: Any) -> datetime | None:
    """Parse ``2026-07-25T11:00:00`` into a *naive* datetime.

    Any offset is stripped rather than converted: this value is a theatre-local
    wall clock destined for a ``TIMESTAMP WITHOUT TIME ZONE`` column, and
    normalizing it to UTC is exactly the bug we store two columns to avoid.
    Mirrors ``_clean_showtime_at`` in ``schemas/watches.py``.
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
        resp = await _request(client, theatre_id, showtime_id, candidate)
        if resp.status_code != 401:
            await cineplex_key.store_api_key(redis, candidate)
            await log.awarning("cineplex_key_refreshed", tried=len(candidates))
            return resp

    # ERROR, not warning: every theatrical-API feature is now dark until someone
    # intervenes.  This is the same class of alarm as the upstream-403 canary —
    # wire it into alerting alongside it.
    await log.aerror("cineplex_key_refresh_failed", candidates=len(candidates))
    return None
