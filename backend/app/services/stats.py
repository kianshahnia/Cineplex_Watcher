"""Stats service — aggregate usage metrics for the admin dashboard.

Unlike the rest of ``services/`` (which is always scoped to one user), this is
a read-only aggregation over the *whole* database. Every metric is a ``COUNT``
— optionally grouped or time-windowed — issued straight to Postgres via
SQLAlchemy's ``func.count()``, so the counting happens in the database engine
and we never pull rows into Python just to ``len()`` them.

There are ~a dozen small queries here. That's deliberately fine: the admin
stats endpoint is hit occasionally by an operator, not on any hot path, so
clarity (one obvious query per number) beats folding everything into one
hand-optimised statement.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Select, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.magic_link import MagicLink
from app.models.notification import Notification
from app.models.seat_event import SeatEvent
from app.models.showtime import Showtime
from app.models.user import User
from app.models.watch import Watch
from app.models.watched_seat import WatchedSeat


async def _count(db: AsyncSession, stmt: Select[Any]) -> int:
    """Run a scalar ``COUNT`` statement, coercing a ``NULL`` result to 0."""
    return (await db.scalar(stmt)) or 0


async def get_stats(db: AsyncSession) -> dict[str, Any]:
    """Compute the full usage-metrics snapshot in one call.

    Returns a plain dict shaped for ``AdminStatsData.model_validate()``. The
    time-windowed counts ("new in the last 7 days") are computed against the
    call time, so two calls a minute apart can differ by exactly the rows
    created in between — that's expected, this is a live snapshot, not a cache.
    """
    now = datetime.now(timezone.utc)
    last_7d = now - timedelta(days=7)
    last_30d = now - timedelta(days=30)

    # --- Users ---------------------------------------------------------------
    # A `users` row exists iff someone completed a magic-link login at least
    # once (see services.auth.get_or_create_user), so total_users == "distinct
    # people who have ever logged in".
    total_users = await _count(db, select(func.count()).select_from(User))
    new_users_7d = await _count(
        db, select(func.count()).select_from(User).where(User.created_at >= last_7d)
    )
    new_users_30d = await _count(
        db, select(func.count()).select_from(User).where(User.created_at >= last_30d)
    )
    # "Active users" == distinct people with at least one active watch. Each
    # user has exactly one email (users.email UNIQUE), and Watch.user_id FKs to
    # that row, so counting distinct user_ids over active watches is the same as
    # counting distinct emails — and avoids a join back to users.
    active_users = await _count(
        db,
        select(func.count(distinct(Watch.user_id))).where(Watch.status == "active"),
    )
    # notify_via is a comma-separated string ('email', 'email,sms', ...). We
    # group by the raw column value for a rough breakdown — good enough without
    # splitting/normalising channels in SQL.
    channel_rows = (
        await db.execute(select(User.notify_via, func.count()).group_by(User.notify_via))
    ).all()
    by_channel = {row[0]: row[1] for row in channel_rows}

    # --- Logins (magic_links) ------------------------------------------------
    links_requested = await _count(db, select(func.count()).select_from(MagicLink))
    completed_logins = await _count(
        db, select(func.count()).select_from(MagicLink).where(MagicLink.used.is_(True))
    )
    # Distinct email addresses that ever *requested* a link (a superset of
    # total_users: someone can request a link and never click it).
    distinct_emails = await _count(db, select(func.count(distinct(MagicLink.email))))

    # --- Watches -------------------------------------------------------------
    total_watches = await _count(db, select(func.count()).select_from(Watch))
    # One grouped query gives every status bucket at once; we read the ones we
    # care about out of the dict with a 0 default so a never-seen status
    # (e.g. no 'expired' watches yet) reports 0 rather than erroring.
    status_rows = (
        await db.execute(select(Watch.status, func.count()).group_by(Watch.status))
    ).all()
    by_status = {row[0]: row[1] for row in status_rows}
    new_watches_7d = await _count(
        db, select(func.count()).select_from(Watch).where(Watch.created_at >= last_7d)
    )

    # --- Showtimes -----------------------------------------------------------
    total_showtimes = await _count(db, select(func.count()).select_from(Showtime))
    active_showtimes = await _count(
        db,
        select(func.count()).select_from(Showtime).where(Showtime.is_active.is_(True)),
    )

    # --- Seats + events ------------------------------------------------------
    watched_seats_total = await _count(db, select(func.count()).select_from(WatchedSeat))
    # notified_at is stamped once per seat when ANY channel first delivers, so
    # this counts *seats that fired an alert*, not messages sent (a batched
    # email about 5 seats stamps 5 rows). See docs/context.md Phase 3 Step 3.
    seats_notified = await _count(
        db,
        select(func.count())
        .select_from(WatchedSeat)
        .where(WatchedSeat.notified_at.is_not(None)),
    )
    seat_events_total = await _count(db, select(func.count()).select_from(SeatEvent))

    # --- Notifications (true message-send volume) ----------------------------
    # One `notifications` row per message per channel attempt, written by the
    # send_notifications Celery task since migration 004. Unlike
    # seats.notified_total (which counts seats), delivered_total counts actual
    # messages — the email slice should match the Resend dashboard. Rows only
    # exist from the migration onward; history before it is not reconstructable.
    messages_attempted = await _count(
        db, select(func.count()).select_from(Notification)
    )
    messages_delivered = await _count(
        db,
        select(func.count())
        .select_from(Notification)
        .where(Notification.success.is_(True)),
    )
    delivered_7d = await _count(
        db,
        select(func.count())
        .select_from(Notification)
        .where(Notification.success.is_(True), Notification.created_at >= last_7d),
    )
    delivered_channel_rows = (
        await db.execute(
            select(Notification.channel, func.count())
            .where(Notification.success.is_(True))
            .group_by(Notification.channel)
        )
    ).all()
    delivered_by_channel = {row[0]: row[1] for row in delivered_channel_rows}

    return {
        "generated_at": now,
        "users": {
            "total": total_users,
            "active": active_users,
            "new_last_7d": new_users_7d,
            "new_last_30d": new_users_30d,
            "by_channel": by_channel,
        },
        "logins": {
            "links_requested": links_requested,
            "completed": completed_logins,
            "distinct_emails": distinct_emails,
        },
        "watches": {
            "total": total_watches,
            "active": by_status.get("active", 0),
            "fulfilled": by_status.get("fulfilled", 0),
            "cancelled": by_status.get("cancelled", 0),
            "expired": by_status.get("expired", 0),
            "new_last_7d": new_watches_7d,
        },
        "showtimes": {
            "total": total_showtimes,
            "active": active_showtimes,
        },
        "seats": {
            "watched_total": watched_seats_total,
            "notified_total": seats_notified,
        },
        "events": {
            "seat_open_total": seat_events_total,
        },
        "notifications": {
            "attempted_total": messages_attempted,
            "delivered_total": messages_delivered,
            "delivered_last_7d": delivered_7d,
            "delivered_by_channel": delivered_by_channel,
        },
    }
