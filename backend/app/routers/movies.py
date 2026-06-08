"""Movies router — landing-page "Now Playing" carousel (TMDB-backed)."""

import structlog
from fastapi import APIRouter, Request

from app.schemas.auth import ErrorResponse
from app.schemas.movies import NowPlayingMovie, NowPlayingResponse
from app.services import movies as movies_service
from app.services.rate_limit import ip_key, limiter

log = structlog.get_logger()

router = APIRouter(prefix="/movies", tags=["movies"])


@router.get(
    "/now-playing",
    response_model=NowPlayingResponse,
    responses={429: {"model": ErrorResponse}},
    summary="Movies currently in theatres (for the landing-page carousel)",
)
# Per-IP: this endpoint is intentionally unauthenticated (it feeds the public
# landing page).  The result is Redis-cached, so it rarely reaches TMDB — the
# cap is just a circuit breaker against a client hammering the endpoint.
@limiter.limit("30/minute", key_func=ip_key)
async def now_playing(request: Request) -> NowPlayingResponse:
    """Return up to eight now-playing movies ranked by popularity.

    Always responds 200 with the standard envelope.  When TMDB isn't configured
    or is unreachable the list is empty and the frontend falls back to its brand
    motif — a decorative widget must never error the page.
    """
    movies = await movies_service.fetch_now_playing(request.app.state.redis)
    return NowPlayingResponse(data=[NowPlayingMovie(**m) for m in movies])
