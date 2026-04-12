import uuid

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
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

    user: Mapped["User"] = relationship(back_populates="watches")  # noqa: F821
    showtime: Mapped["Showtime"] = relationship(back_populates="watches")  # noqa: F821
    watched_seats: Mapped[list["WatchedSeat"]] = relationship(  # noqa: F821
        back_populates="watch", cascade="all, delete-orphan"
    )
