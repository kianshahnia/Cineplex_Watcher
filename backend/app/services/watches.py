"""Watch service — business logic for creating, querying, and cancelling seat watches."""

import uuid

import structlog
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.showtime import Showtime
from app.models.watch import Watch
from app.models.watched_seat import WatchedSeat

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Showtime get-or-create (deduplication)
# ---------------------------------------------------------------------------


async def get_or_create_showtime(
    theatre_id: int,
    showtime_id: int,
    db: AsyncSession,
) -> Showtime:
    """Return the existing Showtime row or create a stub.

    Multiple users can watch the same showtime, so the showtimes table has a
    UNIQUE constraint on (theatre_id, showtime_id).  This function handles that
    deduplication transparently, including a race-condition guard for concurrent
    requests that both try to create the same showtime simultaneously.

    The stub only stores the IDs.  Movie name, theater name, and seat layout are
    populated later by the showtime router (Phase 2 Step 3) when it calls the
    Cineplex API.
    """
    lookup = select(Showtime).where(
        Showtime.theatre_id == theatre_id,
        Showtime.showtime_id == showtime_id,
    )

    result = await db.execute(lookup)
    showtime = result.scalar_one_or_none()
    if showtime is not None:
        return showtime

    showtime = Showtime(theatre_id=theatre_id, showtime_id=showtime_id)
    db.add(showtime)
    try:
        await db.commit()
        await db.refresh(showtime)
    except IntegrityError:
        # Another concurrent request already inserted this showtime.
        await db.rollback()
        result = await db.execute(lookup)
        showtime = result.scalar_one()

    await log.ainfo("showtime_created", theatre_id=theatre_id, showtime_id=showtime_id)
    return showtime


# ---------------------------------------------------------------------------
# Watch CRUD
# ---------------------------------------------------------------------------


async def create_watch(
    user_id: uuid.UUID,
    theatre_id: int,
    showtime_id: int,
    notify_any_seat: bool,
    db: AsyncSession,
) -> Watch:
    """Create a new watch for a user + showtime pair.

    Raises 409 if the user already has a watch (any status) for this showtime.
    Reuses the existing Showtime row if another user already created one.
    """
    showtime = await get_or_create_showtime(theatre_id, showtime_id, db)

    # Enforce the unique constraint at the application layer so we can give a
    # clear error message before the DB raises an IntegrityError.
    existing_stmt = select(Watch).where(
        Watch.user_id == user_id,
        Watch.showtime_id == showtime.id,
    )
    result = await db.execute(existing_stmt)
    if result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You are already watching this showtime.",
        )

    watch = Watch(
        user_id=user_id,
        showtime_id=showtime.id,
        notify_any_seat=notify_any_seat,
    )
    db.add(watch)
    await db.commit()
    await db.refresh(watch)

    await log.ainfo("watch_created", watch_id=str(watch.id), user_id=str(user_id))
    return await _load_watch(watch.id, db)


async def add_seats(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    seats: list[dict[str, str]],
    db: AsyncSession,
) -> Watch:
    """Append seats to an existing watch.

    Each entry in `seats` must have ``seat_key`` and ``seat_label``.
    Already-tracked seats are silently skipped (idempotent).
    Raises 400 if the watch is not active, 403 if the caller doesn't own it.
    """
    await _require_active_watch(watch_id, user_id, db)

    # Fetch the set of seat keys already tracked for this watch in one query
    # so we avoid N separate existence checks inside the loop.
    existing_stmt = select(WatchedSeat.seat_key).where(WatchedSeat.watch_id == watch_id)
    result = await db.execute(existing_stmt)
    already_tracked: set[str] = {row[0] for row in result.all()}

    new_seats = [
        WatchedSeat(
            watch_id=watch_id,
            seat_key=s["seat_key"],
            seat_label=s["seat_label"],
        )
        for s in seats
        if s["seat_key"] not in already_tracked
    ]

    if new_seats:
        db.add_all(new_seats)
        await db.commit()

    await log.ainfo(
        "seats_added",
        watch_id=str(watch_id),
        added=len(new_seats),
        skipped=len(seats) - len(new_seats),
    )
    return await _load_watch(watch_id, db)


async def list_watches(
    user_id: uuid.UUID,
    status_filter: str | None,
    db: AsyncSession,
) -> list[Watch]:
    """Return all of a user's watches, optionally filtered by status.

    Passing ``status_filter=None`` returns every watch regardless of status.
    Results are ordered newest-first.
    """
    stmt = (
        select(Watch)
        .where(Watch.user_id == user_id)
        .options(
            selectinload(Watch.watched_seats),
            selectinload(Watch.showtime),
        )
        .order_by(Watch.created_at.desc())
    )
    if status_filter is not None:
        stmt = stmt.where(Watch.status == status_filter)

    result = await db.execute(stmt)
    return list(result.scalars().all())


async def cancel_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Soft-cancel a watch by setting its status to 'cancelled'.

    The row is kept for audit history.  Raises 400 if already cancelled/expired,
    403 if the caller doesn't own it, 404 if it doesn't exist.
    """
    watch = await _get_own_watch(watch_id, user_id, db)

    if watch.status in ("cancelled", "expired"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Watch is already '{watch.status}'.",
        )

    watch.status = "cancelled"
    await db.commit()

    await log.ainfo("watch_cancelled", watch_id=str(watch_id), user_id=str(user_id))
    return await _load_watch(watch_id, db)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


async def _get_own_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Fetch a watch by ID, enforcing ownership. Raises 404 or 403."""
    stmt = select(Watch).where(Watch.id == watch_id)
    result = await db.execute(stmt)
    watch = result.scalar_one_or_none()

    if watch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watch not found.")
    if watch.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your watch.")
    return watch


async def _require_active_watch(
    watch_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession,
) -> Watch:
    """Like _get_own_watch but also requires status == 'active'."""
    watch = await _get_own_watch(watch_id, user_id, db)
    if watch.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot modify a watch with status '{watch.status}'.",
        )
    return watch


async def _load_watch(watch_id: uuid.UUID, db: AsyncSession) -> Watch:
    """Re-fetch a watch with its relationships eagerly loaded for serialization."""
    stmt = (
        select(Watch)
        .where(Watch.id == watch_id)
        .options(
            selectinload(Watch.watched_seats),
            selectinload(Watch.showtime),
        )
    )
    result = await db.execute(stmt)
    return result.scalar_one()
