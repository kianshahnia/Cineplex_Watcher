import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

# Max length mirrors the watches.name column (VARCHAR(120)).
_NAME_MAX_LEN = 120


def _clean_name(value: str | None) -> str | None:
    """Trim a user-supplied watch name; treat blank/whitespace as 'no name'."""
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _clean_showtime_at(value: datetime | None) -> datetime | None:
    """Normalise the user-picked showtime to a naive (tz-less) datetime.

    The ``watches.showtime_at`` column is ``TIMESTAMP WITHOUT TIME ZONE`` — it
    holds the theatre-local wall-clock the user selected, rendered back
    verbatim. The frontend sends a naive ISO string (no offset), but if a
    tz-aware value ever slips through we drop the offset and keep the wall-clock
    so it still renders as the user intended (and so asyncpg doesn't reject an
    aware datetime against a naive column).
    """
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.replace(tzinfo=None)
    return value


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
    name: str | None
    # User-picked screening date/time (naive wall-clock). Distinct from the
    # nested showtime.showtime_at, which is the (always-NULL) shared metadata.
    showtime_at: datetime | None
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
    name: str | None = Field(default=None, max_length=_NAME_MAX_LEN)
    showtime_at: datetime | None = None

    _clean_name = field_validator("name")(_clean_name)
    _clean_showtime_at = field_validator("showtime_at")(_clean_showtime_at)


class UpdateWatchRequest(BaseModel):
    """Patch a watch's editable fields (name and/or showtime date/time).

    Both fields are optional and only applied when present in the request body
    (the router uses ``model_dump(exclude_unset=True)``), so a PATCH that sends
    only ``name`` leaves ``showtime_at`` untouched and vice-versa. Send a field
    as ``null`` to explicitly clear it.
    """

    name: str | None = Field(default=None, max_length=_NAME_MAX_LEN)
    showtime_at: datetime | None = None

    _clean_name = field_validator("name")(_clean_name)
    _clean_showtime_at = field_validator("showtime_at")(_clean_showtime_at)


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
