"""Cineplex APIM subscription-key manager — discovery, storage, and self-heal.

Cineplex's *theatrical* API product (``/prod/cpx/theatrical/…``, the one that
resolves a showtime's real movie title / theatre / start time) sits behind an
Azure API Management subscription gate that the seat endpoints
(``/prod/ticketing/…``) do not have.  Every request needs an
``Ocp-Apim-Subscription-Key`` header or it returns **401**.

The key is not a per-user credential — Cineplex ships it to every visitor
inside their public JavaScript bundle, so any browser that loads cineplex.com
already has it.  We hold it server-side (it is config, not a user secret) and
resolve it in this order:

1. **Redis** (``cineplex:apim_key``) — a scraped, known-good key.  Present only
   after a successful self-heal, and shared by every backend worker so one
   worker's discovery immediately benefits the rest.
2. **``settings.cineplex_api_key``** — the seed value from ``.env``.
3. Neither → ``None``, and the metadata feature no-ops.  Same "blank value =
   dev-mode no-op" convention as the Resend / Twilio / TMDB integrations.

Self-heal: when the key rotates, every request starts 401ing.  Rather than
requiring a human to notice and redeploy, :func:`refresh_candidates` re-scrapes
the live bundle and hands back fresh candidates for the caller to retry with.

Scraping is two hops (verified live 2026-07-24):

1. ``GET https://www.cineplex.com/`` → regex out the content-hashed chunk path
   ``/_next/static/chunks/pages/_app-<hash>.js``.
2. ``GET`` that chunk (~600 KB) → regex out the 32-hex key literals.

**Why the scraper collects *every* match instead of the first one.**  The
bundle currently contains **two different** valid keys (one used by the
ticketing/theatrical config, one by the smart-app-banner config) — both return
200 against the theatrical endpoint, but they are distinct values, so "take the
first match" is a silent coin-flip on regex/sort order.  It also contains an
all-zeros placeholder that 401s.  There is no way to tell a good key from a bad
one by inspection, so we return an ordered candidate list and let the caller
*prove* one works by making the request it was going to make anyway.

**Why there is a loose fallback regex.**  A previously-documented secondary
pattern (``ocpApimSubscriptionKey:"…"``) matched zero times three days after it
was recorded — Cineplex restructures this bundle often enough that a single
precise pattern is a real availability risk.  So after the precise header
pattern we sweep for bare 32-hex string literals, minus obvious placeholders.
That over-matches by design; validation-by-retry filters the noise.
"""

import re

import httpx
import structlog

from app.config import settings

log = structlog.get_logger()

CINEPLEX_HOME_URL = "https://www.cineplex.com/"

# Honest app identifier rather than a spoofed browser UA — same reasoning as the
# poll cycle's `_USER_AGENT`: Cineplex's WAF filters on IP reputation, so a fake
# browser string buys nothing and an accurate one is good-citizen behaviour.
_USER_AGENT = "Cinewatch/1.0 (+https://cinewatch.ca)"

# Hop 1: the content-hashed app chunk that carries the API config.
_APP_CHUNK_RE = re.compile(r"/_next/static/chunks/pages/_app-[0-9a-f]+\.js")

# Hop 2, precise: the key exactly where it is used, as a request header literal.
_HEADER_KEY_RE = re.compile(r'"Ocp-Apim-Subscription-Key"\s*:\s*"([0-9a-f]{32})"')

# Hop 2, loose fallback: any bare 32-hex string literal.  Over-matches on
# purpose (see module docstring); candidates are validated by retry.
_LOOSE_KEY_RE = re.compile(r'"([0-9a-f]{32})"')

# Where a self-healed key lives.  A long TTL because rotations are rare and the
# value is re-derivable — the expiry exists only so a stale key can't outlive
# its usefulness forever, not as a refresh mechanism.
_REDIS_KEY = "cineplex:apim_key"
_REDIS_KEY_TTL_SEC = 30 * 24 * 3600

# Single-flight guard: a burst of concurrent 401s (every in-flight request fails
# at once when a key rotates) must trigger ONE ~600 KB scrape, not N of them.
_SCRAPE_LOCK_KEY = "lock:cineplex_key_scrape"
_SCRAPE_LOCK_TTL_SEC = 60

# The scrape is off the user-facing request path only in the sense that it is
# rare; it still blocks the request that triggered it, so keep it bounded.
_SCRAPE_TIMEOUT_SEC = 10.0

# Cap on how many candidates a caller will burn requests validating.  The bundle
# realistically holds 2-3; this stops a bundle restructure that makes the loose
# regex match dozens from turning one 401 into a request storm.
MAX_CANDIDATES = 3


# ---------------------------------------------------------------------------
# Key resolution + storage
# ---------------------------------------------------------------------------


async def get_api_key(redis) -> str | None:
    """Return the subscription key to use, or ``None`` if the feature is off.

    Prefers a self-healed key from Redis over the ``.env`` seed: if the seed has
    rotated out from under us, the scraped replacement is the current truth and
    every worker should converge on it.
    """
    stored = await _read_stored_key(redis)
    if stored:
        return stored
    return settings.cineplex_api_key or None


async def store_api_key(redis, key: str) -> None:
    """Persist a validated key so other workers stop paying for the discovery.

    Best-effort: a Redis failure here only means the next 401 re-scrapes.
    """
    try:
        await redis.set(_REDIS_KEY, key, ex=_REDIS_KEY_TTL_SEC)
    except Exception as exc:  # noqa: BLE001 — caching must never fail the caller
        await log.awarning("cineplex_key_store_failed", error=str(exc))


async def _read_stored_key(redis) -> str | None:
    """Read the self-healed key from Redis, tolerating a Redis outage."""
    try:
        stored = await redis.get(_REDIS_KEY)
    except Exception as exc:  # noqa: BLE001 — a Redis blip falls back to the seed
        await log.awarning("cineplex_key_read_failed", error=str(exc))
        return None
    return stored if stored and is_valid_key(stored) else None


# ---------------------------------------------------------------------------
# Self-heal
# ---------------------------------------------------------------------------


async def refresh_candidates(redis, *, failed_key: str) -> list[str]:
    """Return keys worth retrying after ``failed_key`` produced a 401.

    Ordered best-guess first.  May be empty, which the caller should treat as
    "give up for now" — never as an error to retry in a loop.

    Three ways this returns without scraping:

    * auto-scrape disabled by config;
    * another worker already self-healed while we were failing (Redis now holds
      a key that is not the one we tried) — reuse it rather than duplicating the
      work;
    * another worker is scraping *right now* (we lost the lock race).  Returning
      empty here is deliberate: this request fails, and the next one picks up
      the winner's result from Redis.
    """
    if not settings.cineplex_key_autoscrape:
        await log.awarning("cineplex_key_autoscrape_disabled")
        return []

    stored = await _read_stored_key(redis)
    if stored and stored != failed_key:
        await log.ainfo("cineplex_key_refreshed_by_peer")
        return [stored]

    if not await _acquire_scrape_lock(redis):
        await log.ainfo("cineplex_key_scrape_skipped_locked")
        return []

    candidates = await scrape_candidate_keys()
    return [key for key in candidates if key != failed_key][:MAX_CANDIDATES]


async def _acquire_scrape_lock(redis) -> bool:
    """Claim the right to scrape for the next ``_SCRAPE_LOCK_TTL_SEC`` seconds.

    ``SET key value NX EX ttl`` — the same Redis lock primitive the poll cycle
    uses (see ``services/redis_client.py``).  There is no release: the TTL *is*
    the cooldown, so a rotation can't cause a scrape per request even if every
    candidate fails.

    Fails **open** (returns ``True``) when Redis is unreachable — one redundant
    scrape is a far better outcome than a permanently un-healable key.
    """
    try:
        acquired = await redis.set(_SCRAPE_LOCK_KEY, "1", nx=True, ex=_SCRAPE_LOCK_TTL_SEC)
    except Exception as exc:  # noqa: BLE001 — see docstring: fail open
        await log.awarning("cineplex_key_scrape_lock_failed", error=str(exc))
        return True
    return bool(acquired)


# ---------------------------------------------------------------------------
# Scraping
# ---------------------------------------------------------------------------


async def scrape_candidate_keys() -> list[str]:
    """Scrape cineplex.com's app bundle for subscription-key candidates.

    Returns an ordered, de-duplicated list (precise header matches first, loose
    32-hex literals after), or an empty list on any failure.  Never raises — the
    caller is already in a degraded path and must be able to give up cleanly.
    """
    try:
        async with httpx.AsyncClient(
            timeout=_SCRAPE_TIMEOUT_SEC,
            headers={"User-Agent": _USER_AGENT},
            follow_redirects=True,
        ) as client:
            home = await client.get(CINEPLEX_HOME_URL)
            home.raise_for_status()

            chunk_match = _APP_CHUNK_RE.search(home.text)
            if chunk_match is None:
                await log.aerror("cineplex_key_scrape_no_chunk")
                return []

            chunk_url = f"https://www.cineplex.com{chunk_match.group(0)}"
            bundle = await client.get(chunk_url)
            bundle.raise_for_status()
    except httpx.HTTPError as exc:
        await log.awarning("cineplex_key_scrape_request_failed", error=str(exc))
        return []

    candidates = extract_keys(bundle.text)
    if not candidates:
        # Loud on purpose: this is the failure mode that silently disables the
        # whole metadata feature, and it has precedent (a previously-working
        # pattern went dead within days).  It means the regexes need re-deriving
        # against the live bundle, which no amount of retrying will fix.
        await log.aerror("cineplex_key_scrape_no_candidates", chunk_url=chunk_url)
        return []

    await log.ainfo("cineplex_key_scraped", chunk_url=chunk_url, candidates=len(candidates))
    return candidates


def extract_keys(bundle: str) -> list[str]:
    """Pull ordered key candidates out of the app bundle's source text.

    Pure function (no I/O) so the regexes can be exercised against a saved
    bundle without touching the network.
    """
    ordered: list[str] = []
    seen: set[str] = set()
    # Precise matches first — highest confidence, since they appear literally in
    # the position we are about to use them (an outgoing request header).
    for pattern in (_HEADER_KEY_RE, _LOOSE_KEY_RE):
        for key in pattern.findall(bundle):
            if key in seen or not is_valid_key(key):
                continue
            seen.add(key)
            ordered.append(key)
    return ordered


def is_valid_key(key: str) -> bool:
    """Reject anything that cannot be a real key before spending a request on it.

    Beyond the shape check this drops degenerate literals — the bundle ships an
    all-zeros placeholder alongside the real keys, and a run of one repeated
    character is a placeholder in every case we have seen.
    """
    if not re.fullmatch(r"[0-9a-f]{32}", key):
        return False
    return len(set(key)) > 1
