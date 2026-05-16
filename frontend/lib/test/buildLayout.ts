/**
 * ============================================================================
 * TEST FIXTURE — Cineplex JSON → frontend SeatMapLayout converter.
 *
 * Mirrors what `backend/app/services/cineplex.py` does on the server side:
 * merge the seat-layout response with the seat-availability response into
 * the flattened, snake-cased shape the frontend already consumes.
 *
 * Keeping this conversion on the client (rather than just hard-coding a
 * pre-converted layout) is intentional: it lets a developer eyeball the
 * raw Cineplex JSON next to the rendered seat map and see precisely how
 * the transformation works.
 *
 * Remove this entire `lib/test/` folder before shipping to production.
 * ============================================================================
 */

import type {
  RowDetail,
  SeatDetail,
  SeatMapLayout,
  ShowtimeWithSeats,
} from "@/lib/api";

import sample from "./cineplex-sample.json";

interface RawSeat {
  id: string;
  column: number;
  columnPhysicalNumber: number;
  label: string;
  type: string;
}

interface RawRow {
  number: number;
  physicalNumber: number;
  label: string;
  seats: RawSeat[];
}

interface RawLayout {
  totalRows: number;
  totalColumns: number;
  maxSeatSelectionAllowed: number;
  standardSeats: {
    areaWidth: number;
    columnCount: number;
    rowCount: number;
    rows: RawRow[];
  };
}

interface RawAvailability {
  seatAvailabilities: Record<string, string>;
  isSoldOut: boolean;
  isPostShowtime: boolean;
}

interface RawCineplexSample {
  seatLayout: RawLayout;
  seatAvailability: RawAvailability;
}

/**
 * The fictional showtime IDs used everywhere the test fixture surfaces.
 * Chosen so that `parseShowtimeUrl()` interceptor + URL slug parser line up.
 */
export const TEST_THEATRE_ID = 99999;
export const TEST_SHOWTIME_ID = 99999;

/**
 * Stable UUID for the fake showtime row.  The dashboard `WatchCardLive` and
 * the watch page both check `showtime.id` against this to decide whether to
 * skip the real WebSocket and run the fake event emitter instead.
 */
export const TEST_SHOWTIME_UUID = "00000000-0000-0000-0000-000000099999";

function convertSeat(raw: RawSeat, availability: Record<string, string>): SeatDetail {
  return {
    id: raw.id,
    column: raw.column,
    label: raw.label,
    type: raw.type,
    status: availability[raw.id] ?? "Unknown",
  };
}

function convertRow(raw: RawRow, availability: Record<string, string>): RowDetail {
  return {
    number: raw.number,
    physical_number: raw.physicalNumber,
    label: raw.label,
    seats: raw.seats.map((s) => convertSeat(s, availability)),
  };
}

function convertLayout(raw: RawCineplexSample): SeatMapLayout {
  const availability = raw.seatAvailability.seatAvailabilities;
  return {
    total_rows: raw.seatLayout.totalRows,
    total_columns: raw.seatLayout.totalColumns,
    rows: raw.seatLayout.standardSeats.rows.map((row) =>
      convertRow(row, availability),
    ),
  };
}

/**
 * Produce a fresh ShowtimeWithSeats every call (never share refs — callers
 * may mutate the returned layout into local state).
 */
export function buildTestShowtimeWithSeats(): ShowtimeWithSeats {
  const raw = sample as unknown as RawCineplexSample;
  return {
    showtime: {
      id: TEST_SHOWTIME_UUID,
      theatre_id: TEST_THEATRE_ID,
      showtime_id: TEST_SHOWTIME_ID,
      movie_name: "Sample Feature (Test)",
      theater_name: "Cinewatcher Preview Theatre",
      showtime_at: nextWeekendIso(),
      is_active: true,
    },
    layout: convertLayout(raw),
    is_sold_out: raw.seatAvailability.isSoldOut,
    is_post_showtime: raw.seatAvailability.isPostShowtime,
  };
}

/** Return an ISO timestamp for Saturday 7:30pm of the upcoming weekend. */
function nextWeekendIso(): string {
  const d = new Date();
  const daysUntilSaturday = (6 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilSaturday);
  d.setHours(19, 30, 0, 0);
  return d.toISOString();
}

/** Predicate used across the codebase to gate test-only code paths. */
export function isTestShowtimeIds(
  theatre_id: number,
  showtime_id: number,
): boolean {
  return theatre_id === TEST_THEATRE_ID && showtime_id === TEST_SHOWTIME_ID;
}

export function isTestShowtimeUuid(uuid: string | null | undefined): boolean {
  return uuid === TEST_SHOWTIME_UUID;
}
