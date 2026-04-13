"""Showtimes router — seat map lookup and URL parsing."""

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
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

log = structlog.get_logger()

router = APIRouter(prefix="/showtimes", tags=["showtimes"])


@router.get(
    "/{theatre_id}/{showtime_id}",
    response_model=ShowtimeSeatsResponse,
    responses={502: {"model": ErrorResponse}},
    summary="Get merged seat map for a showtime",
)
async def get_showtime_seats(
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
    responses={400: {"model": ErrorResponse}},
    summary="Extract theatre + showtime IDs from a Cineplex URL",
)
async def parse_url(body: ParseUrlRequest) -> ParseUrlResponse:
    """Parse a user-pasted Cineplex URL and return the IDs the frontend needs
    to call ``GET /showtimes/{theatre_id}/{showtime_id}``.

    Accepts the Cineplex API URL format::

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
