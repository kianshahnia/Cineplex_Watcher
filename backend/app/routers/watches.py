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
    BulkDeleteData,
    BulkDeleteResponse,
    BulkRenameData,
    BulkRenameRequest,
    BulkRenameResponse,
    BulkWatchRequest,
    CreateWatchRequest,
    FanoutRequest,
    FanoutResponse,
    FanoutResult,
    FanoutResults,
    UpdateWatchRequest,
    WatchDetailResponse,
    WatchListResponse,
    WatchResponse,
)
from app.services import fanout as fanout_service
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


@router.post(
    "/fanout",
    response_model=FanoutResponse,
    responses={422: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Apply a seat selection across a film's other showings",
)
# Per-user, and the tightest limit in the app: each target costs one live
# Cineplex request plus several DB writes, so a single call is already worth up
# to 8 upstream requests.  Cineplex request volume from our one Canadian egress
# IP is the project's binding constraint — 10/min bounds this endpoint to the
# same order as the seat-map endpoint while leaving real use unhindered.
@limiter.limit("10/minute")
async def fanout_watches(
    request: Request,
    body: FanoutRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FanoutResponse:
    """Apply seat selections to several showings of the same film at once.

    Every target must be a genuine sibling of ``source_showtime_id`` — the same
    film, on the same screen, on the same day — which the server re-derives from
    Cineplex rather than trusting from the client.  Seats are carried per target,
    so the same endpoint serves both "the same seats everywhere" and "a different
    pick per showtime".

    **Partial success is the contract.**  This returns 200 whenever the request
    was well-formed; each target reports its own outcome in ``data.results``, and
    one target failing never rolls back the others.  A target is ``skipped`` when
    a safety guard refuses it (not a sibling, seat map doesn't match, already
    started) and ``failed`` when something went wrong that is worth retrying.

    Targets are capped at ``MAX_FANOUT_TARGETS`` by the request schema.
    """
    outcomes = await fanout_service.fan_out_watches(
        user_id=user.id,
        theatre_id=body.theatre_id,
        source_showtime_id=body.source_showtime_id,
        targets=[
            fanout_service.FanoutTarget(
                showtime_id=t.showtime_id,
                seats=[s.model_dump() for s in t.seats],
            )
            for t in body.targets
        ],
        notify_any_seat=body.notify_any_seat,
        name=body.name,
        redis=request.app.state.redis,
        db=db,
    )
    return FanoutResponse(
        data=FanoutResults(results=[FanoutResult.model_validate(o) for o in outcomes])
    )


@router.post(
    "/bulk-delete",
    response_model=BulkDeleteResponse,
    responses={422: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Permanently delete several watches at once",
)
# Per-user.  One call is one transaction regardless of how many watches it
# names, so the cost per request is on the same order as the single-watch
# delete — hence the same 30/min.  ``MAX_BULK_WATCHES`` on the schema is what
# bounds one call; this bounds the sequence of them.  The frontend routes
# *every* deletion through here, including a single card's, so a limit tighter
# than the single-watch endpoint's would be a regression.
@limiter.limit("30/minute")
async def bulk_delete_watches(
    request: Request,
    body: BulkWatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BulkDeleteResponse:
    """Permanently delete every listed watch you own.

    The bulk counterpart to ``DELETE /watches/{id}/remove``, for the dashboard's
    multi-select edit mode.  Ids you don't own (or that no longer exist) come
    back under ``missing`` instead of failing the call — a batch that aborts
    because one row went stale in another tab helps nobody.  Deletion is
    permanent: seats and seat events go with the watch, while the
    ``notifications`` audit log survives with a NULL ``watch_id``.
    """
    deleted = await watch_service.bulk_delete_watches(
        watch_ids=body.watch_ids,
        user_id=user.id,
        db=db,
    )
    found = set(deleted)
    return BulkDeleteResponse(
        data=BulkDeleteData(
            deleted=deleted,
            missing=[wid for wid in body.watch_ids if wid not in found],
        )
    )


@router.post(
    "/bulk-rename",
    response_model=BulkRenameResponse,
    responses={422: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    summary="Apply one name to several watches at once",
)
# Per-user; same reasoning as bulk-delete above, and the same limit as the
# single-watch PATCH it batches.
@limiter.limit("30/minute")
async def bulk_rename_watches(
    request: Request,
    body: BulkRenameRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BulkRenameResponse:
    """Set the same label on every listed watch you own.

    Send ``name: null`` (or an empty string) to clear the label, which drops the
    cards back to the resolved movie title.  Works on any status, matching
    ``PATCH /watches/{id}``.  Returns the updated watches so the client can
    splice them in place rather than refetching the list.
    """
    updated = await watch_service.bulk_update_name(
        watch_ids=body.watch_ids,
        user_id=user.id,
        name=body.name,
        db=db,
    )
    found = {w.id for w in updated}
    return BulkRenameResponse(
        data=BulkRenameData(
            updated=[WatchResponse.model_validate(w) for w in updated],
            missing=[wid for wid in body.watch_ids if wid not in found],
        )
    )


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
