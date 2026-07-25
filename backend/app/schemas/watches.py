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
    # Aware UTC instant (scheduling math). ``showtime_local`` is the naive
    # theatre-local wall clock and is what clients should display — see the
    # field docs on ``schemas/showtimes.ShowtimeDetail``.
    showtime_at: datetime | None
    showtime_local: datetime | None
    # Presentation formats off metadata_json — see schemas/showtimes.ShowtimeDetail.
    experience_types: list[str] = []
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
# Fan-out — apply a selection across a film's other showings
# ---------------------------------------------------------------------------

#: Hard cap on how many showtimes one call may touch. Real sibling sets run 2-6.
#: This is the most upstream-expensive endpoint in the app (one live Cineplex
#: request per target), and Cineplex request volume from our single Canadian
#: egress IP is the project's binding constraint — so the cap is what bounds a
#: single call's blast radius.
MAX_FANOUT_TARGETS = 8


class FanoutTargetInput(BaseModel):
    """One showtime to apply seats to.

    Seats are carried **per target** rather than shared across the request. That
    is what lets one endpoint serve both selection modes: "same seats for all"
    simply repeats the same list on every target, while "per showtime" sends a
    different one each time.
    """

    showtime_id: int
    seats: list[SeatInput] = []


class FanoutRequest(BaseModel):
    theatre_id: int
    #: The showtime whose page the user is on. Its siblings are re-derived
    #: server-side from this, and every target must be one of them.
    source_showtime_id: int
    notify_any_seat: bool = False
    name: str | None = Field(default=None, max_length=_NAME_MAX_LEN)
    targets: list[FanoutTargetInput] = Field(min_length=1, max_length=MAX_FANOUT_TARGETS)

    _clean_name = field_validator("name")(_clean_name)

    @field_validator("targets")
    @classmethod
    def _reject_duplicate_targets(
        cls, value: list[FanoutTargetInput]
    ) -> list[FanoutTargetInput]:
        """One entry per showtime.

        A repeated showtime would be applied twice, and since the second pass
        sees an active watch it would silently report ``updated`` for what the
        caller thinks is a fresh target. Rejecting outright is clearer than
        merging seat lists we were not asked to merge.
        """
        seen = {t.showtime_id for t in value}
        if len(seen) != len(value):
            raise ValueError("Each showtime may appear only once in targets.")
        return value


class FanoutResult(BaseModel):
    """The outcome for one target. Rendered as one line in the results list."""

    showtime_id: int
    #: ``created`` | ``updated`` | ``reactivated`` | ``skipped`` | ``failed``.
    #: The first three all mean "you are now watching this showtime"; they are
    #: reported separately because a reactivated watch had its previous seats
    #: cleared, which is worth being able to say.
    status: str
    watch_id: uuid.UUID | None = None
    #: Total seats now tracked on that watch, not just the ones this call added.
    seats_applied: int = 0
    #: Requested seats that are already free at this showtime right now — worth
    #: telling the user immediately rather than watching for them. Screen-only;
    #: no notification is sent, since they are looking straight at it.
    already_available: list[str] = []
    #: Human-readable reason, set on ``skipped`` / ``failed``.
    message: str | None = None

    model_config = {"from_attributes": True}


class FanoutResults(BaseModel):
    results: list[FanoutResult]


# ---------------------------------------------------------------------------
# Response envelopes
# ---------------------------------------------------------------------------


class WatchDetailResponse(BaseModel):
    data: WatchResponse
    error: None = None


class WatchListResponse(BaseModel):
    data: list[WatchResponse]
    error: None = None


class FanoutResponse(BaseModel):
    """Standard envelope for the fan-out endpoint.

    Always 200 when the request itself was well-formed: partial success is the
    contract, so per-target failures live in ``data.results`` rather than in a
    status code.
    """

    data: FanoutResults
    error: None = None
