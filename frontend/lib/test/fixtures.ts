/**
 * ============================================================================
 * TEST FIXTURE — entry point for the frontend-only preview scaffolding.
 *
 * Activate the preview by either:
 *   1. Pasting `test_watch.pr` (the URL constant below) into the URL input on
 *      the landing page.  The interceptor in lib/api.ts:parseShowtimeUrl
 *      short-circuits the backend call and returns the test IDs.
 *   2. Entering `watcher@test.pr` (the email constant below) into the magic
 *      link form.  The interceptors in lib/api.ts:requestMagicLink +
 *      verifyMagicLink establish a fake session in localStorage.
 *
 * Once a test session exists, every helper in lib/api.ts that consults it
 * (getMe, listWatches, createWatch, addSeatsToWatch, cancelWatch) operates
 * against the in-browser store in this file rather than the FastAPI backend.
 *
 * Each intercept is marked with a "TEST FIXTURE" comment in lib/api.ts so
 * the seams are easy to find.  Delete this folder + those intercepts before
 * shipping to production.
 * ============================================================================
 */

import type {
  CurrentUser,
  SeatToWatch,
  Watch,
  WatchStatus,
  WatchUpdate,
} from "@/lib/api";

import {
  TEST_SHOWTIME_ID,
  TEST_SHOWTIME_UUID,
  TEST_THEATRE_ID,
} from "./buildLayout";

// --- Constants ------------------------------------------------------------

export const TEST_URL = "test_watch.pr";
export const TEST_EMAIL = "watcher@test.pr";
export const TEST_MAGIC_TOKEN = "cinewatcher-test-magic-token";

export const TEST_USER: CurrentUser = {
  id: "00000000-0000-0000-0000-0000000000aa",
  email: TEST_EMAIL,
  phone: null,
  notify_via: "email",
  created_at: "2026-05-01T12:00:00.000Z",
};

const SESSION_KEY = "cinewatcher.test.session";
const WATCHES_KEY = "cinewatcher.test.watches";

// --- Predicates -----------------------------------------------------------

export function isTestUrl(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  // Accept "test_watch.pr", "http://test_watch.pr", "https://test_watch.pr",
  // and "test_watch.pr/" — every shape a developer might naturally type.
  return (
    trimmed === TEST_URL ||
    trimmed === `http://${TEST_URL}` ||
    trimmed === `https://${TEST_URL}` ||
    trimmed === `${TEST_URL}/` ||
    trimmed === `http://${TEST_URL}/` ||
    trimmed === `https://${TEST_URL}/`
  );
}

export function isTestEmail(email: string): boolean {
  return email.trim().toLowerCase() === TEST_EMAIL;
}

export function isTestMagicToken(token: string): boolean {
  return token === TEST_MAGIC_TOKEN;
}

// --- Test session (localStorage-backed) ----------------------------------

interface TestSession {
  user: CurrentUser;
  signed_in_at: string;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hasTestSession(): boolean {
  const ls = safeLocalStorage();
  return ls?.getItem(SESSION_KEY) !== null;
}

export function getTestSession(): TestSession | null {
  const ls = safeLocalStorage();
  const raw = ls?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "user" in parsed &&
      "signed_in_at" in parsed
    ) {
      return parsed as TestSession;
    }
  } catch {
    // fall through
  }
  return null;
}

export function setTestSession(): TestSession {
  const session: TestSession = {
    user: TEST_USER,
    signed_in_at: new Date().toISOString(),
  };
  const ls = safeLocalStorage();
  if (ls) ls.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearTestSession(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  ls.removeItem(SESSION_KEY);
  ls.removeItem(WATCHES_KEY);
}

// --- Test watches store (localStorage-backed) ----------------------------

function makeFakeId(): string {
  // RFC-ish format — only used as a unique key inside the test store.
  return `test-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function readWatches(): Watch[] {
  const ls = safeLocalStorage();
  const raw = ls?.getItem(WATCHES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Watch[];
  } catch {
    // fall through
  }
  return [];
}

function writeWatches(watches: Watch[]): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  ls.setItem(WATCHES_KEY, JSON.stringify(watches));
}

export function listTestWatches(filter: WatchStatus | "all" = "active"): Watch[] {
  const all = readWatches();
  if (filter === "all") return all;
  return all.filter((w) => w.status === filter);
}

export function createTestWatch(args: {
  theatre_id: number;
  showtime_id: number;
  notify_any_seat: boolean;
  name?: string | null;
  showtime_at?: string | null;
}): Watch {
  const watches = readWatches();
  // The dedup behavior in the real backend: re-use an existing active watch
  // for the same (user, showtime) pair rather than creating a duplicate.
  const existing = watches.find(
    (w) =>
      w.status === "active" &&
      w.showtime.theatre_id === args.theatre_id &&
      w.showtime.showtime_id === args.showtime_id,
  );
  if (existing) return existing;

  const watch: Watch = {
    id: makeFakeId(),
    showtime: {
      id: TEST_SHOWTIME_UUID,
      theatre_id: args.theatre_id,
      showtime_id: args.showtime_id,
      movie_name: "Sample Feature (Test)",
      theater_name: "Cinewatcher Preview Theatre",
      showtime_at: null,
      is_active: true,
    },
    status: "active",
    name: args.name?.trim() || null,
    showtime_at: args.showtime_at ?? null,
    notify_any_seat: args.notify_any_seat,
    seats: [],
    created_at: new Date().toISOString(),
  };
  writeWatches([...watches, watch]);
  return watch;
}

export function updateTestWatch(
  watch_id: string,
  updates: WatchUpdate,
): Watch | null {
  const watches = readWatches();
  const idx = watches.findIndex((w) => w.id === watch_id);
  if (idx === -1) return null;
  const existing = watches[idx];
  if (!existing) return null;
  // Mirror the backend's partial-update semantics: only touch the keys present.
  const updated: Watch = { ...existing };
  if ("name" in updates) updated.name = updates.name?.trim() || null;
  if ("showtime_at" in updates) updated.showtime_at = updates.showtime_at ?? null;
  const next = [...watches];
  next[idx] = updated;
  writeWatches(next);
  return updated;
}

export function addSeatsToTestWatch(
  watch_id: string,
  seats: SeatToWatch[],
): Watch | null {
  const watches = readWatches();
  const idx = watches.findIndex((w) => w.id === watch_id);
  if (idx === -1) return null;
  const existing = watches[idx];
  if (!existing) return null;
  const existingKeys = new Set(existing.seats.map((s) => s.seat_key));
  const additions = seats.filter((s) => !existingKeys.has(s.seat_key));
  const merged: Watch = {
    ...existing,
    seats: [
      ...existing.seats,
      ...additions.map((s) => ({
        id: makeFakeId(),
        seat_key: s.seat_key,
        seat_label: s.seat_label,
        last_known_status: "Occupied",
        notified_at: null,
      })),
    ],
  };
  const next = [...watches];
  next[idx] = merged;
  writeWatches(next);
  return merged;
}

export function cancelTestWatch(watch_id: string): Watch | null {
  const watches = readWatches();
  const idx = watches.findIndex((w) => w.id === watch_id);
  if (idx === -1) return null;
  const existing = watches[idx];
  if (!existing) return null;
  const cancelled: Watch = { ...existing, status: "cancelled" };
  const next = [...watches];
  next[idx] = cancelled;
  writeWatches(next);
  return cancelled;
}

export function removeTestWatch(watch_id: string): boolean {
  const watches = readWatches();
  const next = watches.filter((w) => w.id !== watch_id);
  if (next.length === watches.length) return false;
  writeWatches(next);
  return true;
}

// --- Pre-seeded watches for first-time visitors --------------------------

/**
 * Seed two example watches if the store is empty.  Lets a first-time visitor
 * see the dashboard populated even before they create their own watch.
 */
export function seedTestWatchesIfEmpty(): void {
  if (readWatches().length > 0) return;
  const now = new Date();
  const fulfilledAt = new Date(now.getTime() - 3 * 86400 * 1000).toISOString();
  const createdAt = new Date(now.getTime() - 4 * 86400 * 1000).toISOString();
  writeWatches([
    {
      id: "test-seed-fulfilled-001",
      showtime: {
        id: "00000000-0000-0000-0000-000000099001",
        theatre_id: 1151,
        showtime_id: 88110,
        movie_name: "A Past Showtime (Test)",
        theater_name: "Cinewatcher Archive",
        showtime_at: fulfilledAt,
        is_active: false,
      },
      status: "fulfilled",
      name: null,
      showtime_at: "2026-05-30T19:30:00",
      notify_any_seat: false,
      seats: [
        {
          id: "test-seed-seat-1",
          seat_key: "1_5_4",
          seat_label: "D4",
          last_known_status: "Available",
          notified_at: fulfilledAt,
        },
        {
          id: "test-seed-seat-2",
          seat_key: "1_5_5",
          seat_label: "D5",
          last_known_status: "Available",
          notified_at: fulfilledAt,
        },
      ],
      created_at: createdAt,
    },
  ]);
}

export { TEST_SHOWTIME_ID, TEST_SHOWTIME_UUID, TEST_THEATRE_ID };
