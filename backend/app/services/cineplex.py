"""Cineplex API client — fetch seat layout, availability, and parse URLs."""

import re
from urllib.parse import parse_qs, urlparse

import httpx
import structlog
from fastapi import HTTPException, status

log = structlog.get_logger()

CINEPLEX_API_BASE = "https://apis.cineplex.com/prod/ticketing/api/v1"

# ---------------------------------------------------------------------------
# URL parsing — extract theatre_id + showtime_id from user-pasted URLs
# ---------------------------------------------------------------------------

# Matches the Cineplex API URL (the one test_scraper.py uses):
#   https://apis.cineplex.com/prod/ticketing/api/v1/theatre/1405/showtime/528426/...
_API_URL_RE = re.compile(r"theatre/(\d+)/showtime/(\d+)")

# The public preview page uses both names interchangeably depending on entry point:
# the user-pasted URL typically has `theatreId`, while the page's internal router
# rewrites it to `locationId` after navigation. Accept either.
_PREVIEW_THEATRE_PARAMS = ("theatreId", "locationId")
_PREVIEW_SHOWTIME_PARAM = "showtimeId"


def parse_cineplex_url(url: str) -> tuple[int, int]:
    """Extract (theatre_id, showtime_id) from a Cineplex URL.

    Accepts two formats:

    1. The public ticketing preview URL a user pastes from their browser::

           https://www.cineplex.com/ticketing/preview?theatreId=1151&showtimeId=88110&dbox=true

       The `theatreId` parameter is also accepted as `locationId` (the page's
       internal router rewrites between them).

    2. The Cineplex API URL itself, useful for dev/testing::

           https://apis.cineplex.com/prod/ticketing/api/v1/theatre/1405/showtime/528426/seat-availability

    Returns:
        A tuple of (theatre_id, showtime_id).

    Raises:
        ValueError: if neither format can be matched.
    """
    parsed = urlparse(url.strip())
    if parsed.query:
        params = parse_qs(parsed.query)
        showtime_values = params.get(_PREVIEW_SHOWTIME_PARAM)
        theatre_values = next(
            (params[name] for name in _PREVIEW_THEATRE_PARAMS if name in params),
            None,
        )
        if showtime_values and theatre_values:
            try:
                return int(theatre_values[0]), int(showtime_values[0])
            except ValueError:
                raise ValueError(
                    "Cineplex preview URL has non-numeric theatreId or showtimeId."
                )

    match = _API_URL_RE.search(url)
    if match:
        return int(match.group(1)), int(match.group(2))

    raise ValueError(
        "Could not extract theatre and showtime IDs from the URL. "
        "Expected either a Cineplex preview URL "
        "('.../ticketing/preview?theatreId=...&showtimeId=...') "
        "or an API URL ('.../theatre/{id}/showtime/{id}/...')."
    )


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


async def _cineplex_get(path: str) -> dict:
    """Send a GET to the Cineplex API and return parsed JSON.

    Raises HTTP 502 if the upstream request fails so the caller can relay a
    clear error to the frontend.
    """
    url = f"{CINEPLEX_API_BASE}{path}"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, timeout=15)
        except httpx.RequestError as exc:
            await log.awarn("cineplex_request_error", url=url, error=str(exc))
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not reach the Cineplex API.",
            )

    if resp.status_code != 200:
        await log.awarn("cineplex_non_200", url=url, status_code=resp.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Cineplex API returned status {resp.status_code}.",
        )

    return resp.json()


# ---------------------------------------------------------------------------
# Public API methods
# ---------------------------------------------------------------------------


async def fetch_seat_layout(theatre_id: int, showtime_id: int) -> dict:
    """Fetch the full seat layout (rows, columns, seat metadata) for a showtime.

    This data is mostly static — seats don't move — so the caller should cache
    the result in ``showtimes.seat_layout_json``.
    """
    return await _cineplex_get(f"/theatre/{theatre_id}/showtime/{showtime_id}/seats")


async def fetch_seat_availability(theatre_id: int, showtime_id: int) -> dict:
    """Fetch the current seat availability for a showtime.

    This data changes constantly (when people book or abandon carts) so it
    should always be fetched fresh — never cached.
    """
    return await _cineplex_get(f"/theatre/{theatre_id}/showtime/{showtime_id}/seat-availability")


# ---------------------------------------------------------------------------
# Merge layout + availability into a frontend-ready structure
# ---------------------------------------------------------------------------


def merge_layout_and_availability(layout_json: dict, availability_json: dict) -> dict:
    """Combine the static seat layout with live availability into one structure.

    Returns a dict with the shape::

        {
            "total_rows": int,
            "total_columns": int,
            "rows": [
                {
                    "number": int,
                    "physical_number": int,
                    "label": str,            # "AA", "A", "B", …
                    "seats": [
                        {
                            "id": str,       # "1_14_23"
                            "column": int,   # grid column for visual layout
                            "label": str,    # "AA1"
                            "type": str,     # "Standard", "Wheelchair", …
                            "status": str,   # "Available" | "Occupied" | "Unknown"
                        }
                    ]
                }
            ]
        }

    Rows with an empty ``seats`` list (physical gaps / aisles) are preserved so
    the frontend can render the correct spacing.
    """
    statuses: dict[str, str] = availability_json.get("seatAvailabilities", {})
    standard = layout_json.get("standardSeats", {})

    rows: list[dict] = []
    for raw_row in standard.get("rows", []):
        seats: list[dict] = []
        for raw_seat in raw_row.get("seats", []):
            seat_id = raw_seat["id"]
            seats.append(
                {
                    "id": seat_id,
                    "column": raw_seat["column"],
                    "label": raw_seat.get("label", seat_id),
                    "type": raw_seat.get("type", "Standard"),
                    "status": statuses.get(seat_id, "Unknown"),
                }
            )
        rows.append(
            {
                "number": raw_row["number"],
                "physical_number": raw_row.get("physicalNumber", raw_row["number"]),
                "label": raw_row.get("label", str(raw_row["number"])),
                "seats": seats,
            }
        )

    return {
        "total_rows": layout_json.get("totalRows", len(rows)),
        "total_columns": layout_json.get("totalColumns", 0),
        "rows": rows,
    }
