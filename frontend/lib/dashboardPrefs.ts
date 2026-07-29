/**
 * Dashboard view preferences — how the watchlist is grouped, how it is sorted,
 * and which group rows are open.
 *
 * Stored in `localStorage`, so the choice is per device and costs no backend.
 * Structured exactly like `lib/watchSelection.ts`: a pure parse/serialize half
 * and a thin DOM half, which is what makes the format verifiable without a
 * browser. If cross-device persistence is ever wanted, the two DOM wrappers at
 * the bottom are the only things that change.
 */

import {
  DEFAULT_GROUP_BY,
  DEFAULT_SORT_BY,
  GROUP_BY_VALUES,
  sortOptionsFor,
} from "@/lib/watchGrouping";
import type { GroupBy, SortBy } from "@/lib/watchGrouping";

export const PREFS_STORAGE_KEY = "cinewatch.dashboard.prefs";

/**
 * Ceiling on remembered open rows. Group keys accumulate as watches come and go
 * — a film watched last month keeps its key forever — so the list is capped on
 * write rather than left to grow unbounded.
 */
export const MAX_REMEMBERED_EXPANDED = 200;

export interface DashboardPrefs {
  groupBy: GroupBy;
  sortBy: SortBy;
  /**
   * Keys of the currently-expanded groups. Mode-prefixed ("movie:odyssey",
   * "date:2026-08-01"), so one array serves every mode with no collision.
   */
  expanded: string[];
}

export function defaultPrefs(): DashboardPrefs {
  return {
    groupBy: DEFAULT_GROUP_BY,
    sortBy: DEFAULT_SORT_BY,
    expanded: [],
  };
}

function isGroupBy(value: unknown): value is GroupBy {
  return (
    typeof value === "string" && GROUP_BY_VALUES.includes(value as GroupBy)
  );
}

/**
 * The single repair point for a preferences object.
 *
 * Both the parser and the runtime mode-switch call it, so they cannot drift on
 * what a valid combination is. The case that matters: a stored `sortBy: "name"`
 * is meaningless under `groupBy: "movie"` (every member of a movie group is the
 * same film), so it resets rather than silently doing nothing.
 *
 * The parameter is typed, but the values are treated as untrusted — this is what
 * a corrupt `localStorage` blob arrives as.
 */
export function normalizePrefs(prefs: DashboardPrefs): DashboardPrefs {
  const groupBy: GroupBy = isGroupBy(prefs.groupBy)
    ? prefs.groupBy
    : DEFAULT_GROUP_BY;

  const offered = sortOptionsFor(groupBy);
  const sortBy: SortBy =
    typeof prefs.sortBy === "string" && offered.includes(prefs.sortBy)
      ? prefs.sortBy
      : DEFAULT_SORT_BY;

  const expanded: string[] = [];
  if (Array.isArray(prefs.expanded)) {
    const seen = new Set<string>();
    for (const key of prefs.expanded) {
      if (typeof key !== "string" || key.length === 0) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push(key);
      if (expanded.length >= MAX_REMEMBERED_EXPANDED) break;
    }
  }

  return { groupBy, sortBy, expanded };
}

/**
 * Read a stored blob. Anything unreadable — corrupt JSON, a scalar, an unknown
 * mode, a non-array `expanded` — falls back to the defaults: a bad blob should
 * cost the preference, never the page. Same contract as `parseStoredWorkingSet`.
 */
export function parseStoredPrefs(raw: string | null): DashboardPrefs {
  if (!raw) return defaultPrefs();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPrefs();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultPrefs();
  }

  return normalizePrefs(parsed as DashboardPrefs);
}

export function serializePrefs(prefs: DashboardPrefs): string {
  const clean = normalizePrefs(prefs);
  return JSON.stringify({
    v: 1,
    groupBy: clean.groupBy,
    sortBy: clean.sortBy,
    expanded: clean.expanded,
  });
}

// --- localStorage wrappers -------------------------------------------------

export function loadPrefs(): DashboardPrefs {
  if (typeof window === "undefined") return defaultPrefs();
  try {
    return parseStoredPrefs(window.localStorage.getItem(PREFS_STORAGE_KEY));
  } catch {
    // privacy mode can throw on read
    return defaultPrefs();
  }
}

export function savePrefs(prefs: DashboardPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, serializePrefs(prefs));
  } catch {
    // ignore quota / privacy-mode errors
  }
}
