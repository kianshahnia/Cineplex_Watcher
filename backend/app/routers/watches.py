"""Watches router — CRUD for seat watches."""

import uuid

import structlog
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.schemas.auth import ErrorResponse, MessageResponse
from app.schemas.watches import (
    AddSeatsRequest,
    CreateWatchRequest,
    UpdateWatchRequest,
    WatchDetailResponse,
    WatchListResponse,
    WatchResponse,
)
from app.services import watches as watch_service
from app.services.auth import get_current_user
from app.services.rate_limit import limiter

log = structlog.get_logger()

router = APIRouter(prefix="/watches", tags=["watches"])


@router.post(
    "",
    response_model=WatchDetailResponse,
    status_code=201,
    responses={409: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Create a watch for a showtime",
)
# Per-user (via the default user-or-IP key) — creating a watch fetches the
# Cineplex layout if not cached and writes several DB rows.  20/min is well
# above any realistic human use; a runaway script hits the wall fast.
@limiter.limit("20/minute")
async def create_watch(
    request: Request,
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
        name=body.name,
        showtime_at=body.showtime_at,
        db=db,
    )
    return WatchDetailResponse(data=WatchResponse.model_validate(watch))


@router.patch(
    "/{watch_id}",
    response_model=WatchDetailResponse,
    responses={
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    summary="Update a watch (name and/or showtime date)",
)
# Per-user — an update is a single UPDATE.  30/min comfortably covers inline
# editing on the dashboard while blocking scripted loops.
@limiter.limit("30/minute")
async def update_watch(
    request: Request,
    watch_id: uuid.UUID,
    body: UpdateWatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WatchDetailResponse:
    """Update a watch's name and/or showtime date (editable any time, any status).

    Only the fields present in the request body are changed — a body of
    ``{"name": "Dune"}`` leaves the date untouched, and vice-versa. Send a field
    as ``null`` (or, for the name, an empty string) to clear it.
    """
    # exclude_unset → only fields the client actually sent. Forwarded as kwargs
    # to update_watch, whose _UNSET defaults leave omitted fields alone.
    updates = body.model_dump(exclude_unset=True)
    watch = await watch_service.update_watch(
        watch_id=watch_id,
        user_id=user.id,
        db=db,
        **updates,
    )
    return WatchDetailResponse(data=WatchResponse.model_validate(watch))


@router.post(
    "/{watch_id}/seats",
    response_model=WatchDetailResponse,
    responses={
        400: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    summary="Add specific seats to a watch",
)
# Per-user — adding seats is cheap (single INSERT per seat) but a watch with
# 200 seats has implications for notification fanout downstream.  30/min is
# generous for UI use (one click = one call) and blocks scripted loops.
@limiter.limit("30/minute")
async def add_seats(
    request: Request,
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
    responses={429: {"model": ErrorResponse}},
    summary="List watches",
)
# Per-user — the dashboard refetches this whenever the user lands or filters.
# 60/min easily covers tab-switching + the WatchCardLive periodic refreshes
# without blocking real workflows.
@limiter.limit("60/minute")
async def list_watches(
    request: Request,
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
        429: {"model": ErrorResponse},
    },
    summary="Cancel a watch",
)
# Per-user — soft-delete is cheap.  30/min easily handles the "cancel +
# recreate" flow used to edit watched seats (see docs/context.md Phase 4
# Step 3) without blocking power users.
@limiter.limit("30/minute")
async def cancel_watch(
    request: Request,
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


@router.delete(
    "/{watch_id}/remove",
    response_model=MessageResponse,
    responses={
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    summary="Permanently remove a watch",
)
# Per-user — a hard delete is cheap (one cascading DELETE).  30/min mirrors
# the cancel limit; this is the "clear it off my dashboard" action for any
# watch, including already-cancelled / expired ones that cancel_watch refuses.
@limiter.limit("30/minute")
async def remove_watch(
    request: Request,
    watch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Permanently delete a watch and its seats/events.

    Unlike ``DELETE /watches/{id}`` (which soft-cancels an *active* watch),
    this removes the row outright and works on any status.  Used by the
    dashboard to clear out finished, cancelled, or expired watches.
    """
    await watch_service.delete_watch(
        watch_id=watch_id,
        user_id=user.id,
        db=db,
    )
    return MessageResponse(data={"message": "Watch removed."})
