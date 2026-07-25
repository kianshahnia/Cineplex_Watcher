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
    #: Aware UTC instant. Serialized with an offset, so a browser would render
    #: it in the *viewer's* timezone — correct for scheduling math, wrong for
    #: display. Clients should prefer ``showtime_local``.
    showtime_at: datetime | None
    #: Naive theatre-local wall clock — what the screening's own clock says.
    #: Serialized without an offset so ``new Date(...)`` treats it as local and
    #: an 11:00 AM Vancouver screening reads "11:00 AM" from anywhere.
    showtime_local: datetime | None
    #: Presentation formats (IMAX / 70mm / UltraAVX / Dolby Atmos / 3D), read
    #: off ``metadata_json`` by the ``Showtime.experience_types`` property.
    #: Empty for rows whose metadata never resolved.
    experience_types: list[str] = []
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
# Sibling showtimes
# ---------------------------------------------------------------------------


class AlternativeShowtimeDetail(BaseModel):
    """One other screening of the same film, on the same screen, the same day."""

    showtime_id: int
    #: Aware UTC instant. Scheduling math only — clients should render
    #: ``showtime_local`` so a Vancouver screening reads "3:00 PM" everywhere.
    showtime_at: datetime | None
    #: Naive theatre-local wall clock, serialized without an offset.
    showtime_local: datetime | None
    auditorium: str | None
    #: Soft hint only — this rides a short-lived cache and changes minute to
    #: minute. Never treat it as truth; the seat endpoint is authoritative.
    seats_remaining: int | None
    is_sold_out: bool

    model_config = {"from_attributes": True}


class SiblingShowtimes(BaseModel):
    """The anchor's identity plus every compatible sibling.

    ``alternatives`` is empty both for a film with a single showing and for any
    upstream failure. That is deliberate: the switcher is simply absent in both
    cases, so the client needs no error branch.
    """

    theatre_id: int
    #: The showtime whose link the user pasted.
    showtime_id: int
    #: Shared by the whole set — Cineplex groups siblings by screen and format,
    #: which is what makes their seat maps key-for-key identical.
    auditorium: str | None
    #: The anchor's local start; the set's shared day comes off its date.
    showtime_local: datetime | None
    alternatives: list[AlternativeShowtimeDetail]

    model_config = {"from_attributes": True}


class AlternativesResponse(BaseModel):
    """Standard envelope for the sibling-showtimes endpoint."""

    data: SiblingShowtimes
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
