"""Showtimes router — seat map lookup and URL parsing."""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.auth import ErrorResponse
from app.schemas.showtimes import (
    AlternativesResponse,
    ParsedIds,
    ParseUrlRequest,
    ParseUrlResponse,
    SeatMapLayout,
    ShowtimeDetail,
    ShowtimeSeatsResponse,
    ShowtimeWithSeats,
    SiblingShowtimes,
)
from app.services import cineplex as cineplex_service
from app.services import showtime_alternatives as alternatives_service
from app.services import showtime_metadata as metadata_service
from app.services import watches as watch_service
from app.services.rate_limit import ip_key, limiter

log = structlog.get_logger()

router = APIRouter(prefix="/showtimes", tags=["showtimes"])


@router.get(
    "/{theatre_id}/{showtime_id}",
    response_model=ShowtimeSeatsResponse,
    responses={502: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Get merged seat map for a showtime",
)
# Per-IP (the endpoint is intentionally unauthenticated for preview).  This
# is the only handler that calls the upstream Cineplex API on every request
# — uncontrolled fan-out here is what could get OUR server IP rate-limited
# or banned upstream.  30/min is comfortable for a real user toggling
# between a few showtimes; a scraper hits the wall almost immediately.
@limiter.limit("30/minute", key_func=ip_key)
async def get_showtime_seats(
    request: Request,
    theatre_id: int,
    showtime_id: int,
    db: AsyncSession = Depends(get_db),
) -> ShowtimeSeatsResponse:
    """Fetch the seat layout + live availability for a showtime and return
    them merged into a single structure ready for frontend rendering.

    The seat layout is cached in the database after the first fetch (it's
    static — seats don't move).  Availability is always fetched fresh from
    the Cineplex API.

    This endpoint does NOT require authentication so users can preview the
    seat map before logging in or creating a watch.
    """
    # 1. Get or create the Showtime row (reuses the same deduplication logic
    #    that watch creation uses).
    showtime = await watch_service.get_or_create_showtime(theatre_id, showtime_id, db)

    # 2. Resolve the movie title / theatre / start time on first view.
    #    A sibling of the seat-layout cache below and the same shape: fetch once
    #    from upstream, store it on the shared row, never fetch it again.  This
    #    is the *only* trigger point the feature needs — the watch page SSRs
    #    through this endpoint, so metadata resolves the first time anyone looks
    #    at a showtime, before a watch even exists.  Self-guarding (already
    #    resolved / in cooldown are both no-ops) and never raises; a failure
    #    leaves the columns NULL and the UI on its existing placeholders.
    await metadata_service.ensure_showtime_metadata(showtime, request.app.state.redis, db)

    # 3. Fetch and cache the seat layout if we don't already have it.
    if showtime.seat_layout_json is None:
        layout_data = await cineplex_service.fetch_seat_layout(theatre_id, showtime_id)
        showtime.seat_layout_json = layout_data
        await db.commit()
        await db.refresh(showtime)

    # 4. Always fetch fresh availability.
    availability_data = await cineplex_service.fetch_seat_availability(theatre_id, showtime_id)

    # 5. If the showtime has passed, mark it inactive.
    if availability_data.get("isPostShowtime", False) and showtime.is_active:
        showtime.is_active = False
        await db.commit()
        await db.refresh(showtime)

    # 6. Merge layout + availability into the frontend-ready structure.
    merged = cineplex_service.merge_layout_and_availability(
        showtime.seat_layout_json,
        availability_data,
    )

    return ShowtimeSeatsResponse(
        data=ShowtimeWithSeats(
            showtime=ShowtimeDetail.model_validate(showtime),
            layout=SeatMapLayout.model_validate(merged),
            is_sold_out=availability_data.get("isSoldOut", False),
            is_post_showtime=availability_data.get("isPostShowtime", False),
        )
    )


@router.get(
    "/{theatre_id}/{showtime_id}/alternatives",
    response_model=AlternativesResponse,
    responses={429: {"model": ErrorResponse}},
    summary="List the same film's other showings on the same screen",
)
# Per-IP, matching the seat-map endpoint above and for the same reason: a cache
# miss here reaches the upstream Cineplex API, and uncontrolled fan-out is what
# could get OUR server IP banned.  The 5-minute Redis cache means a real user
# toggling around a watch page rarely reaches upstream at all.
@limiter.limit("30/minute", key_func=ip_key)
async def get_showtime_alternatives(
    request: Request,
    theatre_id: int,
    showtime_id: int,
) -> AlternativesResponse:
    """Return the other showings of this film in this auditorium on this day.

    Powers the watch page's showtime switcher, which lets a user apply one seat
    selection across several screenings instead of repeating the flow per time.

    Unauthenticated, like the seat-map endpoint — the switcher is part of the
    signed-out preview.  Touches no database: siblings are read live from
    Cineplex (through a short Redis cache) rather than from
    ``showtimes.metadata_json``, because that blob is written once and would
    freeze the list on first view.

    **Never fails on upstream trouble.**  A missing key, a 404, or a network
    error all return an empty ``alternatives`` list, which the frontend renders
    as "no switcher" — the same thing it shows for a film with a single showing.
    """
    sibling_set = await alternatives_service.list_alternatives(
        theatre_id,
        showtime_id,
        request.app.state.redis,
    )
    return AlternativesResponse(data=SiblingShowtimes.model_validate(sibling_set))


@router.post(
    "/parse-url",
    response_model=ParseUrlResponse,
    responses={400: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Extract theatre + showtime IDs from a Cineplex URL",
)
# Per-IP — pure CPU work (regex parse), no I/O.  Looser limit reflects the
# low cost per call; the cap is a circuit breaker against runaway clients
# rather than a meaningful resource gate.
@limiter.limit("60/minute", key_func=ip_key)
async def parse_url(request: Request, body: ParseUrlRequest) -> ParseUrlResponse:
    """Parse a user-pasted Cineplex URL and return the IDs the frontend needs
    to call ``GET /showtimes/{theatre_id}/{showtime_id}``.

    Accepts either the public ticketing preview URL (the one a user actually
    pastes from their browser)::

        https://www.cineplex.com/ticketing/preview?theatreId=1151&showtimeId=88110&dbox=true

    or the Cineplex API URL (useful for dev/testing)::

        https://apis.cineplex.com/prod/ticketing/api/v1/theatre/1405/showtime/528426/seat-availability
    """
    try:
        theatre_id, showtime_id = cineplex_service.parse_cineplex_url(body.url)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    return ParseUrlResponse(data=ParsedIds(theatre_id=theatre_id, showtime_id=showtime_id))
