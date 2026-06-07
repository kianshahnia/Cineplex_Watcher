"""Showtimes router — seat map lookup and URL parsing."""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.auth import ErrorResponse
from app.schemas.showtimes import (
    ParsedIds,
    ParseUrlRequest,
    ParseUrlResponse,
    SeatMapLayout,
    ShowtimeDetail,
    ShowtimeSeatsResponse,
    ShowtimeWithSeats,
)
from app.services import cineplex as cineplex_service
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

    # 2. Fetch and cache the seat layout if we don't already have it.
    if showtime.seat_layout_json is None:
        layout_data = await cineplex_service.fetch_seat_layout(theatre_id, showtime_id)
        showtime.seat_layout_json = layout_data
        await db.commit()
        await db.refresh(showtime)

    # 3. Always fetch fresh availability.
    availability_data = await cineplex_service.fetch_seat_availability(theatre_id, showtime_id)

    # 4. If the showtime has passed, mark it inactive.
    if availability_data.get("isPostShowtime", False) and showtime.is_active:
        showtime.is_active = False
        await db.commit()
        await db.refresh(showtime)

    # 5. Merge layout + availability into the frontend-ready structure.
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
