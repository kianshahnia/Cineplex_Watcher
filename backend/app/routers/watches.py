"""Watches router — CRUD for seat watches."""

import uuid

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.schemas.auth import ErrorResponse
from app.schemas.watches import (
    AddSeatsRequest,
    CreateWatchRequest,
    WatchDetailResponse,
    WatchListResponse,
    WatchResponse,
)
from app.services import watches as watch_service
from app.services.auth import get_current_user

log = structlog.get_logger()

router = APIRouter(prefix="/watches", tags=["watches"])


@router.post(
    "",
    response_model=WatchDetailResponse,
    status_code=201,
    responses={409: {"model": ErrorResponse}},
    summary="Create a watch for a showtime",
)
async def create_watch(
    body: CreateWatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WatchDetailResponse:
    """Create a new watch for the authenticated user.

    Accepts ``theatre_id`` and ``showtime_id`` extracted from a Cineplex URL.
    The showtime row is created (or reused) automatically — if another user
    already created a watch for the same showtime, a single shared Showtime row
    is used and polling happens once per showtime.

    Returns 409 if you already have a watch for this showtime.
    """
    watch = await watch_service.create_watch(
        user_id=user.id,
        theatre_id=body.theatre_id,
        showtime_id=body.showtime_id,
        notify_any_seat=body.notify_any_seat,
        db=db,
    )
    return WatchDetailResponse(data=WatchResponse.model_validate(watch))


@router.post(
    "/{watch_id}/seats",
    response_model=WatchDetailResponse,
    responses={
        400: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
    summary="Add specific seats to a watch",
)
async def add_seats(
    watch_id: uuid.UUID,
    body: AddSeatsRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WatchDetailResponse:
    """Append seats to an existing watch.

    Seats that are already tracked are silently skipped (idempotent).
    Requires the watch to have ``status = 'active'``.
    """
    watch = await watch_service.add_seats(
        watch_id=watch_id,
        user_id=user.id,
        seats=[s.model_dump() for s in body.seats],
        db=db,
    )
    return WatchDetailResponse(data=WatchResponse.model_validate(watch))


@router.get(
    "",
    response_model=WatchListResponse,
    summary="List watches",
)
async def list_watches(
    status: str | None = Query(
        default="active",
        description=(
            "Filter by watch status: 'active', 'fulfilled', 'cancelled', 'expired'. "
            "Pass 'all' to return every watch regardless of status."
        ),
    ),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WatchListResponse:
    """Return the authenticated user's watches.

    Defaults to active watches only.  Pass ``?status=all`` to see everything.
    """
    status_filter = None if status == "all" else status
    watches = await watch_service.list_watches(
        user_id=user.id,
        status_filter=status_filter,
        db=db,
    )
    return WatchListResponse(data=[WatchResponse.model_validate(w) for w in watches])


@router.delete(
    "/{watch_id}",
    response_model=WatchDetailResponse,
    responses={
        400: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
    summary="Cancel a watch",
)
async def cancel_watch(
    watch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WatchDetailResponse:
    """Soft-cancel a watch.

    Sets ``status = 'cancelled'`` and stops future notifications for its seats.
    The row is kept for history — use ``GET /watches?status=all`` to see it.
    """
    watch = await watch_service.cancel_watch(
        watch_id=watch_id,
        user_id=user.id,
        db=db,
    )
    return WatchDetailResponse(data=WatchResponse.model_validate(watch))
