import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Notification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Audit log of outbound seat-alert messages — one row per channel attempt.

    Written by the ``send_notifications`` Celery task for every email / SMS /
    push it attempts, success or failure. This is the source of truth for *how
    many messages we actually send* (``watched_seats.notified_at`` counts seats
    that fired, not messages — a batched email about 5 seats stamps 5 rows but
    is 1 message here). Delivered-email rows should match the Resend dashboard.

    Deliberately relationship-free and denormalized:

    - ``watch_id`` is ``ON DELETE SET NULL`` (not CASCADE) so the audit trail
      survives a hard watch delete (``DELETE /watches/{id}/remove``). No ORM
      relationship is declared on ``Watch`` — the FK action is purely DB-level,
      which also keeps the async hard-delete path free of lazy-load cascades.
    - ``user_email`` / ``theatre_id`` / ``showtime_id`` are copied in at send
      time so a row stays meaningful even after its watch (or user) is gone.
    """

    __tablename__ = "notifications"

    watch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("watches.id", ondelete="SET NULL"),
        nullable=True,
    )
    user_email: Mapped[str] = mapped_column(String(255), nullable=False)
    # 'email' | 'sms' | 'push'
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    # True = the transport reported the message handed off to the vendor.
    # False = the attempt failed (vendor error, invalid subscription, or the
    # channel isn't configured — dev mode). Failures are logged on purpose:
    # they're exactly what an audit trail is for.
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # How many newly-available seats this one message covered (per-watch
    # batching: one message carries the whole batch).
    seat_count: Mapped[int] = mapped_column(Integer, nullable=False)
    theatre_id: Mapped[int] = mapped_column(Integer, nullable=False)
    showtime_id: Mapped[int] = mapped_column(Integer, nullable=False)
