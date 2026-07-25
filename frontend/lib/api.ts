/**
 * Thin fetch wrapper for the Cineplex Watcher backend.
 *
 * - Always sends cookies (the FastAPI auth uses an httpOnly session cookie).
 * - Unwraps the standard `{ data, error }` envelope.
 * - Throws an `ApiError` on non-2xx responses or `error` payloads.
 */

// SSR (server-side) uses INTERNAL_API_BASE to reach the backend via the
// Docker internal network. Browser code uses the public NEXT_PUBLIC_API_BASE.
const API_BASE =
  typeof window === "undefined"
    ? (process.env.INTERNAL_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000")
    : (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000");

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface Envelope<T> {
  data: T | null;
  error: { message: string } | null;
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function api<T>(
  path: string,
  { body, headers, ...rest }: ApiOptions = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: Envelope<T> | null = null;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch {
    // Some endpoints (e.g. 204) don't return JSON. Fall through.
  }

  if (!res.ok || payload?.error) {
    const msg =
      payload?.error?.message ??
      `Request failed (${res.status} ${res.statusText})`;
    throw new ApiError(msg, res.status);
  }

  return (payload?.data ?? (undefined as unknown)) as T;
}

// --- Typed endpoint helpers ------------------------------------------------

export interface ParsedIds {
  theatre_id: number;
  showtime_id: number;
}

export function parseShowtimeUrl(url: string): Promise<ParsedIds> {
  return api<ParsedIds>("/showtimes/parse-url", {
    method: "POST",
    body: { url },
  });
}

export interface MagicLinkResult {
  message: string;
  verification_url?: string;
}

export function requestMagicLink(email: string): Promise<MagicLinkResult> {
  return api<MagicLinkResult>("/auth/login", {
    method: "POST",
    body: { email },
  });
}

export function verifyMagicLink(token: string): Promise<{ message: string }> {
  return api<{ message: string }>(
    `/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
}

// --- Movies (landing-page "Now Playing" carousel) -------------------------

export interface NowPlayingMovie {
  id: number;
  title: string;
  poster_url: string;
  release_date: string | null;
  vote_average: number;
  popularity: number;
  overview: string | null;
}

/**
 * Movies currently in theatres (TMDB, region-scoped to Canada on the backend,
 * ranked by popularity). The backend returns an empty list when TMDB isn't
 * configured or is unreachable, so callers should treat `[]` as "show the
 * fallback", not an error.
 */
export function getNowPlaying(): Promise<NowPlayingMovie[]> {
  return api<NowPlayingMovie[]>("/movies/now-playing", {
    method: "GET",
    cache: "no-store",
  });
}

// --- Seat map -------------------------------------------------------------

export interface SeatDetail {
  id: string;
  column: number;
  label: string;
  type: string;
  status: "Available" | "Occupied" | "Unknown" | string;
}

export interface RowDetail {
  number: number;
  physical_number: number;
  label: string;
  seats: SeatDetail[];
}

export interface SeatMapLayout {
  total_rows: number;
  total_columns: number;
  rows: RowDetail[];
}

export interface ShowtimeDetail {
  id: string;
  theatre_id: number;
  showtime_id: number;
  movie_name: string | null;
  theater_name: string | null;
  /**
   * Aware UTC instant, offset included. `new Date()` renders it in the
   * *viewer's* timezone — right for scheduling math, wrong for display.
   * Prefer `showtime_local` in the UI.
   */
  showtime_at: string | null;
  /**
   * Theatre-local wall clock as a naive ISO string (`YYYY-MM-DDTHH:MM:SS`).
   * Offset-less, so `new Date()` reads it as local time and an 11:00 AM
   * Vancouver screening displays as "11:00 AM" from anywhere. Display this.
   */
  showtime_local: string | null;
  /**
   * Presentation formats for this screening — e.g. `["IMAX", "70mm"]`,
   * `["UltraAVX", "Dolby Atmos"]`. Tokens are Cineplex's own branding and are
   * rendered verbatim. Empty when the showtime's metadata never resolved.
   */
  experience_types: string[];
  is_active: boolean;
}

export interface ShowtimeWithSeats {
  showtime: ShowtimeDetail;
  layout: SeatMapLayout;
  is_sold_out: boolean;
  is_post_showtime: boolean;
}

export function getShowtimeSeats(
  theatre_id: number,
  showtime_id: number,
): Promise<ShowtimeWithSeats> {
  return api<ShowtimeWithSeats>(
    `/showtimes/${theatre_id}/${showtime_id}`,
    { method: "GET", cache: "no-store" },
  );
}

// --- Sibling showtimes ----------------------------------------------------

export interface AlternativeShowtime {
  showtime_id: number;
  /** Aware UTC instant — see `ShowtimeDetail.showtime_at`. Not for display. */
  showtime_at: string | null;
  /** Naive theatre-local wall clock — display this one. */
  showtime_local: string | null;
  auditorium: string | null;
  /**
   * Soft hint only. It rides a short-lived server cache and changes minute to
   * minute; the seat map is the authoritative source. Never gate anything on it.
   */
  seats_remaining: number | null;
  is_sold_out: boolean;
}

export interface SiblingShowtimes {
  theatre_id: number;
  /** The showtime whose link the user pasted — excluded from `alternatives`. */
  showtime_id: number;
  /** Shared by the whole set: Cineplex groups siblings by screen and format. */
  auditorium: string | null;
  showtime_local: string | null;
  alternatives: AlternativeShowtime[];
}

/**
 * The same film's other showings, on the same screen, on the same day.
 *
 * The backend never fails this on upstream trouble — a missing key, a 404, or a
 * network error all come back as an empty `alternatives` list, the same thing a
 * film with a single showing returns. So callers have no error branch: an empty
 * list simply means "no switcher".
 */
export function getShowtimeAlternatives(
  theatre_id: number,
  showtime_id: number,
): Promise<SiblingShowtimes> {
  return api<SiblingShowtimes>(
    `/showtimes/${theatre_id}/${showtime_id}/alternatives`,
    { method: "GET", cache: "no-store" },
  );
}

// --- Auth / current user --------------------------------------------------

export interface CurrentUser {
  id: string;
  email: string;
  phone: string | null;
  notify_via: string;
  created_at: string;
}

/** Returns the current user or null when the session cookie is missing/invalid. */
export async function getMe(): Promise<CurrentUser | null> {
  try {
    return await api<CurrentUser>("/auth/me", {
      method: "GET",
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

// --- Watches --------------------------------------------------------------

export interface WatchedSeat {
  id: string;
  seat_key: string;
  seat_label: string;
  last_known_status: string;
  notified_at: string | null;
}

export interface WatchShowtime {
  id: string;
  theatre_id: number;
  showtime_id: number;
  movie_name: string | null;
  theater_name: string | null;
  /** Aware UTC instant — see `ShowtimeDetail.showtime_at`. Not for display. */
  showtime_at: string | null;
  /** Naive theatre-local wall clock — display this one. */
  showtime_local: string | null;
  /** Presentation formats — see `ShowtimeDetail.experience_types`. */
  experience_types: string[];
  is_active: boolean;
}

export type WatchStatus = "active" | "fulfilled" | "cancelled" | "expired";

export interface Watch {
  id: string;
  showtime: WatchShowtime;
  status: WatchStatus;
  /** User-provided label; null falls back to the movie name / a placeholder. */
  name: string | null;
  /**
   * User-picked screening date/time as a naive ISO string (`YYYY-MM-DDTHH:MM:SS`,
   * theatre-local wall-clock, no offset). Distinct from `showtime.showtime_at`,
   * which is the shared (currently always-null) Cineplex metadata.
   */
  showtime_at: string | null;
  notify_any_seat: boolean;
  seats: WatchedSeat[];
  created_at: string;
}

export function listWatches(
  statusFilter: WatchStatus | "all" = "active",
): Promise<Watch[]> {
  return api<Watch[]>(
    `/watches?status=${encodeURIComponent(statusFilter)}`,
    { method: "GET", cache: "no-store" },
  );
}

export function createWatch(args: {
  theatre_id: number;
  showtime_id: number;
  notify_any_seat: boolean;
  name?: string | null;
  /** Naive ISO (`YYYY-MM-DDTHH:MM:SS`) theatre-local wall-clock, or null. */
  showtime_at?: string | null;
}): Promise<Watch> {
  return api<Watch>("/watches", { method: "POST", body: args });
}

/**
 * Update a watch's editable fields. Pass only the keys you want to change —
 * the backend leaves omitted fields untouched (`PATCH` + `exclude_unset`).
 * Send a field as `null` to clear it. Editable at any status.
 */
export interface WatchUpdate {
  name?: string | null;
  showtime_at?: string | null;
}

export function updateWatch(
  watch_id: string,
  updates: WatchUpdate,
): Promise<Watch> {
  return api<Watch>(`/watches/${watch_id}`, {
    method: "PATCH",
    body: updates,
  });
}

export interface SeatToWatch {
  seat_key: string;
  seat_label: string;
}

export function addSeatsToWatch(
  watch_id: string,
  seats: SeatToWatch[],
): Promise<Watch> {
  return api<Watch>(`/watches/${watch_id}/seats`, {
    method: "POST",
    body: { seats },
  });
}

export function cancelWatch(watch_id: string): Promise<Watch> {
  return api<Watch>(`/watches/${watch_id}`, { method: "DELETE" });
}

// --- Fan-out (apply a selection across a film's other showings) -----------

/**
 * Hard cap on targets per call, mirroring `MAX_FANOUT_TARGETS` in
 * `backend/app/schemas/watches.py`. Exceeding it is a 422, so the UI trims
 * rather than letting the whole batch bounce.
 */
export const MAX_FANOUT_TARGETS = 8;

/**
 * `created` / `updated` / `reactivated` all mean "you are now watching this
 * showtime"; they differ only in what happened to a prior watch. `skipped` is a
 * safety guard refusing the target, `failed` is worth retrying.
 */
export type FanoutStatus =
  | "created"
  | "updated"
  | "reactivated"
  | "skipped"
  | "failed";

export interface FanoutResult {
  showtime_id: number;
  status: FanoutStatus;
  watch_id: string | null;
  /** Total seats now tracked on that watch — not just the ones this call added. */
  seats_applied: number;
  /** Requested seats already free at that showtime right now. Screen-only. */
  already_available: string[];
  message: string | null;
}

export interface FanoutTarget {
  showtime_id: number;
  seats: SeatToWatch[];
}

/**
 * Apply seat selections to several showings of the same film in one call.
 *
 * Seats are carried **per target**, so the same call serves both "the same seats
 * everywhere" and "a different pick per showtime". Partial success is the
 * contract: this resolves with one result per target even when some were
 * refused, and only throws when the request itself was rejected (auth, rate
 * limit, the target cap).
 */
export function fanoutWatches(args: {
  theatre_id: number;
  source_showtime_id: number;
  targets: FanoutTarget[];
  notify_any_seat?: boolean;
  name?: string | null;
}): Promise<FanoutResult[]> {
  return api<{ results: FanoutResult[] }>("/watches/fanout", {
    method: "POST",
    body: args,
  }).then((d) => d.results);
}

/** Permanently delete a watch (hard delete, any status). */
export function removeWatch(watch_id: string): Promise<{ message: string }> {
  return api<{ message: string }>(`/watches/${watch_id}/remove`, {
    method: "DELETE",
  });
}

// --- Sign out -------------------------------------------------------------

export function logout(): Promise<{ message: string }> {
  return api<{ message: string }>("/auth/logout", { method: "POST" });
}
