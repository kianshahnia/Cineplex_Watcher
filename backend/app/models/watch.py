import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Watch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "watches"
    __table_args__ = (UniqueConstraint("user_id", "showtime_id", name="uq_user_showtime"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    showtime_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("showtimes.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    notify_any_seat: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # User-provided label for this watch. NULL falls back to the movie name
    # (currently always NULL) / a generic placeholder in the UI.
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # User-picked screening date/time for this watch. Stored *naive* (no
    # timezone) because it represents the theatre-local wall-clock the user
    # selected and we render it back verbatim — see the migration + the
    # frontend DateTimePicker. NULL falls back to the (always-NULL) showtime
    # metadata / a generic placeholder.
    showtime_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=False), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="watches")  # noqa: F821
    showtime: Mapped["Showtime"] = relationship(back_populates="watches")  # noqa: F821
    watched_seats: Mapped[list["WatchedSeat"]] = relationship(  # noqa: F821
        back_populates="watch", cascade="all, delete-orphan"
    )
