import uuid
from datetime import datetime

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Seat map sub-schemas (output of the merge)
# ---------------------------------------------------------------------------


class SeatDetail(BaseModel):
    """One seat in the merged layout — static position + live status."""

    id: str  # Cineplex key, e.g. "1_14_23"
    column: int  # Grid column for visual layout (determines gaps/aisles)
    label: str  # Human-readable, e.g. "AA1"
    type: str  # "Standard", "Wheelchair", "Companion", etc.
    status: str  # "Available", "Occupied", or "Unknown"


class RowDetail(BaseModel):
    """One row in the seat map."""

    number: int  # Row index from the layout response
    physical_number: int  # Physical row number in the theatre
    label: str  # Row letter(s), e.g. "AA", "A", "B"
    seats: list[SeatDetail]  # Empty list = physical gap / aisle


class SeatMapLayout(BaseModel):
    """The full merged seat map ready for frontend rendering."""

    total_rows: int
    total_columns: int
    rows: list[RowDetail]


# ---------------------------------------------------------------------------
# Showtime metadata
# ---------------------------------------------------------------------------


class ShowtimeDetail(BaseModel):
    """Showtime info stored in our DB."""

    id: uuid.UUID
    theatre_id: int
    showtime_id: int
    movie_name: str | None
    theater_name: str | None
    showtime_at: datetime | None
    is_active: bool

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Composite response
# ---------------------------------------------------------------------------


class ShowtimeWithSeats(BaseModel):
    """Merged showtime metadata + live seat map."""

    showtime: ShowtimeDetail
    layout: SeatMapLayout
    is_sold_out: bool
    is_post_showtime: bool


class ShowtimeSeatsResponse(BaseModel):
    """Standard envelope for the seat-map endpoint."""

    data: ShowtimeWithSeats
    error: None = None


# ---------------------------------------------------------------------------
# URL parsing
# ---------------------------------------------------------------------------


class ParseUrlRequest(BaseModel):
    url: str


class ParsedIds(BaseModel):
    theatre_id: int
    showtime_id: int


class ParseUrlResponse(BaseModel):
    data: ParsedIds
    error: None = None
