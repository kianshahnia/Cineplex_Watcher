from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Showtime(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "showtimes"
    __table_args__ = (UniqueConstraint("theatre_id", "showtime_id", name="uq_theatre_showtime"),)

    theatre_id: Mapped[int] = mapped_column(Integer, nullable=False)
    showtime_id: Mapped[int] = mapped_column(Integer, nullable=False)
    movie_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    theater_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    showtime_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    poll_interval_sec: Mapped[int] = mapped_column(Integer, default=90, nullable=False)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    seat_layout_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    watches: Mapped[list["Watch"]] = relationship(back_populates="showtime", cascade="all, delete-orphan")  # noqa: F821
