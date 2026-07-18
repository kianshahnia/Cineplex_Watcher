"""Pydantic response schemas for the admin usage-metrics endpoint.

Nested sub-models group the numbers by domain (users / logins / watches / …)
so the JSON reads like a small report rather than one flat bag of counts.
``AdminStatsResponse`` is the standard ``{data, error}`` envelope every router
in this app returns.
"""

from datetime import datetime

from pydantic import BaseModel


class UserStats(BaseModel):
    total: int
    new_last_7d: int
    new_last_30d: int
    # Maps each raw notify_via value ('email', 'email,sms', …) to a user count.
    by_channel: dict[str, int]


class LoginStats(BaseModel):
    links_requested: int
    completed: int
    distinct_emails: int


class WatchStats(BaseModel):
    total: int
    active: int
    fulfilled: int
    cancelled: int
    expired: int
    new_last_7d: int


class ShowtimeStats(BaseModel):
    total: int
    active: int


class SeatStats(BaseModel):
    watched_total: int
    # Seats that have fired at least one notification (notified_at set), NOT the
    # number of messages sent — see services/stats.py for the distinction.
    notified_total: int


class EventStats(BaseModel):
    seat_open_total: int


class NotificationStats(BaseModel):
    """True message-send volume from the ``notifications`` audit log.

    One underlying row per message per channel attempt (written by the
    ``send_notifications`` Celery task), so ``delivered_total`` counts actual
    messages — unlike ``SeatStats.notified_total``, which counts seats. The
    email slice of ``delivered_by_channel`` should match the Resend dashboard.
    Counts start at migration 004; earlier sends were never recorded.
    """

    attempted_total: int
    delivered_total: int
    delivered_last_7d: int
    # 'email' / 'sms' / 'push' → delivered message count.
    delivered_by_channel: dict[str, int]


class AdminStatsData(BaseModel):
    """The full metrics snapshot returned inside the envelope's ``data`` key."""

    generated_at: datetime
    users: UserStats
    logins: LoginStats
    watches: WatchStats
    showtimes: ShowtimeStats
    seats: SeatStats
    events: EventStats
    notifications: NotificationStats


class AdminStatsResponse(BaseModel):
    """Standard ``{data, error}`` envelope for ``GET /admin/stats``."""

    data: AdminStatsData
    error: None = None
