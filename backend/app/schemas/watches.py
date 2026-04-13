import uuid
from datetime import datetime

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Sub-schemas
# ---------------------------------------------------------------------------


class SeatInput(BaseModel):
    """One seat the user wants to watch."""

    seat_key: str  # Cineplex API key, e.g. "1_7_4"
    seat_label: str  # Human-readable, e.g. "G4"


class ShowtimeSummary(BaseModel):
    """Minimal showtime data nested inside watch responses."""

    id: uuid.UUID
    theatre_id: int
    showtime_id: int
    movie_name: str | None
    theater_name: str | None
    showtime_at: datetime | None
    is_active: bool

    model_config = {"from_attributes": True}


class WatchedSeatResponse(BaseModel):
    id: uuid.UUID
    seat_key: str
    seat_label: str
    last_known_status: str
    notified_at: datetime | None

    model_config = {"from_attributes": True}


class WatchResponse(BaseModel):
    id: uuid.UUID
    showtime: ShowtimeSummary
    status: str
    notify_any_seat: bool
    # The ORM relationship is named "watched_seats"; we expose it as "seats"
    # in the API to keep the response clean.
    seats: list[WatchedSeatResponse] = Field(validation_alias="watched_seats")
    created_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------


class CreateWatchRequest(BaseModel):
    theatre_id: int
    showtime_id: int
    notify_any_seat: bool = False


class AddSeatsRequest(BaseModel):
    seats: list[SeatInput]


# ---------------------------------------------------------------------------
# Response envelopes
# ---------------------------------------------------------------------------


class WatchDetailResponse(BaseModel):
    data: WatchResponse
    error: None = None


class WatchListResponse(BaseModel):
    data: list[WatchResponse]
    error: None = None
