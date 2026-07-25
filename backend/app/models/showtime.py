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
    # Aware UTC instant (upstream showStartDateTimeUtc). Drives poll-interval math.
    showtime_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Naive theatre-local wall clock (upstream showStartDateTime). Drives all display —
    # emails, watch header, dashboard. Kept separate from showtime_at so we never have
    # to derive a theatre's timezone; Cineplex hands us both values.
    showtime_local: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    # Stamped on every resolution *attempt*. NULL = never tried; non-NULL with a NULL
    # movie_name = tried and failed. This is what keeps a transient failure from being
    # cached as permanently unresolvable.
    metadata_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Trimmed upstream response: poster URLs, runtime, rating, genres, auditorium,
    # experience types, warnings. No UI consumes it yet — captured now so a later
    # session can use it without another migration.
    metadata_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    poll_interval_sec: Mapped[int] = mapped_column(Integer, default=90, nullable=False)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    seat_layout_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    watches: Mapped[list["Watch"]] = relationship(back_populates="showtime", cascade="all, delete-orphan")  # noqa: F821

    @property
    def experience_types(self) -> list[str]:
        """Presentation formats for this screening — IMAX, 70mm, UltraAVX, 3D…

        Read straight out of ``metadata_json["experience_types"]``, which
        ``services/showtime_metadata._trim_metadata`` has been storing since the
        column landed.  Exposed as a plain property (not a Pydantic computed
        field) so every schema with ``from_attributes=True`` picks it up for
        free, and server-side callers can read it the same way.

        Always a list: a row whose metadata never resolved has a NULL
        ``metadata_json`` and yields ``[]``.  Values are filtered to non-empty
        strings because this blob is upstream JSON, not a validated schema.
        """
        raw = (self.metadata_json or {}).get("experience_types")
        if not isinstance(raw, list):
            return []
        return [item.strip() for item in raw if isinstance(item, str) and item.strip()]
