"""TMDB client for the landing-page "Now Playing" poster carousel.

Why this lives behind our backend rather than calling TMDB from the browser:
the TMDB v4 token is a secret and must never ship in the client bundle.  The
backend holds the token, caches the (slowly-changing) result in Redis, and
exposes a trimmed, envelope-wrapped list the frontend can render directly.

Degradation: when ``TMDB_API_TOKEN`` is unset, or TMDB is unreachable, the
service returns an empty list instead of raising.  The carousel is decorative —
a failure here must never break the landing page.  (Same dev-mode-fallback
convention as the Resend / Twilio / Web Push transports.)
"""

import json

import httpx
import structlog

from app.config import settings

log = structlog.get_logger()

TMDB_API_BASE = "https://api.themoviedb.org/3"
# w500 is the sweet spot for a ~248px-wide poster on 2x displays: crisp without
# shipping the full-res original.  (See TMDB's configuration endpoint for the
# full list of available widths.)
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"

# Redis cache — "now playing" changes at most daily, so a few hours of
# staleness is invisible to users and spares us (and TMDB) a request on every
# landing-page load.
_CACHE_KEY = "tmdb:now_playing"
_CACHE_TTL_SEC = 6 * 3600

# How many posters the carousel cycles through.
_MAX_MOVIES = 8


async def fetch_now_playing(redis) -> list[dict]:
    """Return up to ``_MAX_MOVIES`` now-playing movies, ranked by popularity.

    Reads from a Redis cache first; on a miss it calls TMDB, trims + ranks the
    payload, caches it, and returns it.  Any failure (no token, network error,
    non-200) is logged and yields an empty list so the caller can degrade
    gracefully.
    """
    cached = await _read_cache(redis)
    if cached is not None:
        return cached

    # No token → dev-mode no-op (mirrors the Resend / Twilio transports).
    if not settings.tmdb_api_token:
        await log.ainfo("tmdb_now_playing_skipped_no_token")
        return []

    try:
        raw = await _request_now_playing()
    except httpx.HTTPError as exc:
        await log.awarning("tmdb_now_playing_fetch_failed", error=str(exc))
        return []

    movies = _rank_and_trim(raw)

    # Best-effort cache write — a failure here just means we refetch next time.
    try:
        await redis.set(_CACHE_KEY, json.dumps(movies), ex=_CACHE_TTL_SEC)
    except Exception as exc:  # noqa: BLE001 — caching must never fail the request
        await log.awarning("tmdb_now_playing_cache_write_failed", error=str(exc))

    return movies


async def _read_cache(redis) -> list[dict] | None:
    """Return the cached movie list, or ``None`` on miss / unreadable cache."""
    try:
        cached = await redis.get(_CACHE_KEY)
    except Exception as exc:  # noqa: BLE001 — a Redis blip just bypasses the cache
        await log.awarning("tmdb_now_playing_cache_read_failed", error=str(exc))
        return None
    if not cached:
        return None
    try:
        return json.loads(cached)
    except json.JSONDecodeError:
        return None


async def _request_now_playing() -> dict:
    """Call TMDB's now-playing endpoint scoped to the configured region."""
    headers = {
        "Authorization": f"Bearer {settings.tmdb_api_token}",
        "accept": "application/json",
    }
    params = {
        "language": "en-US",
        "page": 1,
        "region": settings.tmdb_region,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{TMDB_API_BASE}/movie/now_playing",
            headers=headers,
            params=params,
            timeout=15,
        )
    # Raises httpx.HTTPStatusError (a subclass of httpx.HTTPError) on non-2xx,
    # which the caller catches alongside network errors.
    resp.raise_for_status()
    return resp.json()


def _rank_and_trim(raw: dict) -> list[dict]:
    """Sort results by popularity desc, drop poster-less entries, keep top N."""
    results = raw.get("results", []) or []
    # TMDB already sorts by popularity.desc, but we don't depend on ordering we
    # don't control.  A movie with no poster_path can't be rendered, so skip it.
    ranked = sorted(
        (m for m in results if m.get("poster_path")),
        key=lambda m: m.get("popularity", 0.0),
        reverse=True,
    )
    movies: list[dict] = []
    for m in ranked[:_MAX_MOVIES]:
        movies.append(
            {
                "id": m["id"],
                "title": m.get("title") or m.get("original_title") or "Untitled",
                "poster_url": f"{TMDB_IMAGE_BASE}{m['poster_path']}",
                "release_date": m.get("release_date") or None,
                "vote_average": float(m.get("vote_average", 0.0)),
                "popularity": float(m.get("popularity", 0.0)),
                "overview": m.get("overview") or None,
            }
        )
    return movies
