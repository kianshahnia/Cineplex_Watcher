import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDPrimaryKeyMixin


class WatchedSeat(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "watched_seats"
    __table_args__ = (UniqueConstraint("watch_id", "seat_key", name="uq_watch_seat"),)

    watch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("watches.id", ondelete="CASCADE"), nullable=False
    )
    seat_key: Mapped[str] = mapped_column(String(20), nullable=False)
    seat_label: Mapped[str] = mapped_column(String(20), nullable=False)
    last_known_status: Mapped[str] = mapped_column(String(20), default="Occupied", nullable=False)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    watch: Mapped["Watch"] = relationship(back_populates="watched_seats")  # noqa: F821
    seat_events: Mapped[list["SeatEvent"]] = relationship(  # noqa: F821
        back_populates="watched_seat", cascade="all, delete-orphan"
    )
