/**
 * Watchlist grouping and sorting — the algebra behind the dashboard's group rows.
 *
 * The dashboard renders one full-size card per watch, and since the
 * sibling-showtimes fan-out shipped, one film across four showings produces four
 * near-identical cards. This module collapses a flat watch list into groups —
 * by film, date, theatre or format — each carrying the summary the collapsed row
 * needs so nothing important hides behind it.
 *
 * Lives in `lib/` rather than inside the dashboard so it can be exercised
 * without React or a CSS-module resolver — same reasoning as
 * `lib/experienceTypes.ts` and `lib/watchSelection.ts`.
 */

import type { Watch, WatchStatus } from "@/lib/api";
import { cleanMovieTitle, unionNearMatches } from "@/lib/movieTitle";
import type { CleanTitle } from "@/lib/movieTitle";

/** Which dimension the list is collapsed on. */
export type GroupBy = "movie" | "date" | "theatre" | "format" | "none";

/** How watches are ordered *within* a group. Groups themselves have a fixed order. */
export type SortBy = "showtime" | "added" | "name" | "format" | "theatre";

export const GROUP_BY_VALUES: readonly GroupBy[] = [
  "movie",
  "date",
  "theatre",
  "format",
  "none",
];

export const SORT_BY_VALUES: readonly SortBy[] = [
  "showtime",
  "added",
  "name",
  "format",
  "theatre",
];

export const DEFAULT_GROUP_BY: GroupBy = "movie";
export const DEFAULT_SORT_BY: SortBy = "showtime";

/**
 * Which sorts each grouping mode offers.
 *
 * An explicit table rather than a rule ("omit whatever you grouped by"), because
 * `date` needs the exception: within a calendar day, time of day is still a real
 * ordering, so grouping by date keeps `showtime`. The other three modes drop the
 * dimension they already grouped on — sorting a movie group by name would be a
 * no-op, since every member is the same film.
 */
const SORT_OPTIONS: Record<GroupBy, readonly SortBy[]> = {
  movie: ["showtime", "added", "format", "theatre"],
  date: ["showtime", "added", "name", "format", "theatre"],
  theatre: ["showtime", "added", "name", "format"],
  format: ["showtime", "added", "name", "theatre"],
  none: ["showtime", "added", "name", "format", "theatre"],
};

export function sortOptionsFor(groupBy: GroupBy): SortBy[] {
  return [...SORT_OPTIONS[groupBy]];
}

/** Shown when a watch has no name and its showtime's metadata never resolved. */
const UNTITLED = "Your watched showtime";

/**
 * What a watch is called on screen.
 *
 * The user's own label wins (it is their personal annotation), then the movie
 * title auto-resolved from Cineplex, then a placeholder. Exported so `WatchCard`
 * and the grouping can never drift on the question of what a watch is called.
 */
export function displayTitle(w: Watch): string {
  return w.name?.trim() || w.showtime.movie_name?.trim() || UNTITLED;
}

/**
 * When a watch screens, as an ISO string, or null when nothing is known.
 *
 * Precedence mirrors `WatchCard`: the user's own per-watch date first, then the
 * theatre-local wall clock resolved from Cineplex. The aware-UTC column is a
 * last resort only — `new Date()` renders it in the *viewer's* timezone, so a
 * Toronto user would see a Vancouver screening shifted by three hours.
 */
export function watchShowtimeIso(w: Watch): string | null {
  return w.showtime_at ?? w.showtime.showtime_local ?? w.showtime.showtime_at;
}

/**
 * One summary item on a collapsed group row — "Riverport", "Aug 1 – Aug 3",
 * "2 formats".
 */
export interface GroupFacet {
  kind: "theatre" | "date" | "format";
  /** False when the group spans several values and `text` is a range or a count. */
  uniform: boolean;
  /** How many distinct values sit behind it. */
  count: number;
  text: string;
}

export interface WatchGroup {
  /** Mode-prefixed so one expanded-keys array serves every mode: "movie:odyssey". */
  key: string;
  label: string;
  /** Already sorted by the caller's `sortBy`, active watches first. */
  watches: Watch[];
  facets: GroupFacet[];
  seatCount: number;
  notifiedCount: number;
  activeCount: number;
  statusCounts: Record<WatchStatus, number>;
  /** "No date set" / "Theatre unknown" / "Standard" — always sorts last. */
  isFallback: boolean;
}

// --- field readers ---------------------------------------------------------

function theatreNameOf(w: Watch): string | null {
  return w.showtime.theater_name?.trim() || null;
}

/** Case- and spacing-insensitive identity for a theatre name. */
function theatreKeyOf(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The showtime's presentation formats, verbatim.
 *
 * Deliberately NOT `filterExperienceTypes` — that helper drops tokens the title
 * already states, so "The Odyssey: The IMAX Experience®" would come back with no
 * formats at all and be filed under Standard. Grouping needs the raw truth about
 * the screening; suppression is a display concern for the badges beside a title.
 */
function formatTokensOf(w: Watch): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of w.showtime.experience_types) {
    if (typeof raw !== "string") continue;
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(token);
  }
  return kept;
}

/** Order-independent identity for a set of format tokens. */
function formatSignatureOf(tokens: readonly string[]): string {
  return tokens
    .map((t) => t.toLowerCase().replace(/\s+/g, " "))
    .sort()
    .join("|");
}

function formatLabelOf(tokens: readonly string[]): string {
  return tokens.join(" · ");
}

function timeValueOf(w: Watch): number | null {
  const iso = watchShowtimeIso(w);
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function createdValueOf(w: Watch): number {
  const t = new Date(w.created_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The calendar day a watch screens on, in the theatre's own reckoning.
 *
 * `showtime_local` is offset-less, so `new Date()` reads it as local time and
 * the local getters hand back the theatre's calendar day — which is the whole
 * point of storing that column alongside the aware UTC one.
 */
function dayOf(w: Watch): { key: string; date: Date } | null {
  const iso = watchShowtimeIso(w);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { key, date: d };
}

// --- date formatting -------------------------------------------------------

/** "Sat, Aug 2" — a whole day, no time. */
function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "Sun, Aug 3, 8:00 PM" — the precise screening, used for single-watch groups. */
function formatPrecise(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRangeEnd(d: Date, withYear: boolean): string {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/**
 * "Aug 1 – Aug 3", the answer to the constraint this whole feature turns on:
 * a group of one film across several dates must never claim a single date.
 */
function formatRange(from: Date, to: Date): string {
  const withYear = from.getFullYear() !== to.getFullYear();
  return `${formatRangeEnd(from, withYear)} – ${formatRangeEnd(to, withYear)}`;
}

// --- facets ----------------------------------------------------------------

function theatreFacet(watches: readonly Watch[]): GroupFacet | null {
  const byKey = new Map<string, string>();
  for (const w of watches) {
    const name = theatreNameOf(w);
    if (name === null) continue;
    const key = theatreKeyOf(name);
    if (!byKey.has(key)) byKey.set(key, name);
  }
  if (byKey.size === 0) return null;
  const first = [...byKey.values()][0] as string;
  return byKey.size === 1
    ? { kind: "theatre", uniform: true, count: 1, text: first }
    : {
        kind: "theatre",
        uniform: false,
        count: byKey.size,
        text: `${byKey.size} theatres`,
      };
}

function dateFacet(watches: readonly Watch[]): GroupFacet | null {
  const byDay = new Map<string, Date>();
  for (const w of watches) {
    const day = dayOf(w);
    if (day === null) continue;
    if (!byDay.has(day.key)) byDay.set(day.key, day.date);
  }
  if (byDay.size === 0) return null;

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (byDay.size === 1) {
    const only = days[0] as [string, Date];
    // One watch, one date: state it precisely, time and all. A group of several
    // watches that happen to share a day only claims the day — the times differ.
    const text =
      watches.length === 1 ? formatPrecise(only[1]) : formatDay(only[1]);
    return { kind: "date", uniform: true, count: 1, text };
  }

  const first = days[0] as [string, Date];
  const last = days[days.length - 1] as [string, Date];
  return {
    kind: "date",
    uniform: false,
    count: byDay.size,
    text: formatRange(first[1], last[1]),
  };
}

function formatFacet(watches: readonly Watch[]): GroupFacet | null {
  const bySignature = new Map<string, string[]>();
  for (const w of watches) {
    const tokens = formatTokensOf(w);
    if (tokens.length === 0) continue;
    const signature = formatSignatureOf(tokens);
    if (!bySignature.has(signature)) bySignature.set(signature, tokens);
  }
  if (bySignature.size === 0) return null;
  const first = [...bySignature.values()][0] as string[];
  return bySignature.size === 1
    ? { kind: "format", uniform: true, count: 1, text: formatLabelOf(first) }
    : {
        kind: "format",
        uniform: false,
        count: bySignature.size,
        text: `${bySignature.size} formats`,
      };
}

/** Every facet except the one the list is already grouped by. */
function buildFacets(watches: readonly Watch[], groupBy: GroupBy): GroupFacet[] {
  const facets: GroupFacet[] = [];
  const push = (f: GroupFacet | null): void => {
    if (f !== null) facets.push(f);
  };
  if (groupBy !== "theatre") push(theatreFacet(watches));
  if (groupBy !== "date") push(dateFacet(watches));
  if (groupBy !== "format") push(formatFacet(watches));
  return facets;
}

// --- bucketing -------------------------------------------------------------

interface Bucket {
  key: string;
  label: string;
  isFallback: boolean;
  watches: Watch[];
}

/**
 * Group by film identity.
 *
 * Two passes: normalize every displayed title to a key, union the near-misses so
 * a typo doesn't split a film, then bucket on the canonical key. The label is
 * the **shortest** clean title among the members, so "The Odyssey" wins over
 * "The Odyssey: The IMAX Experience® in 70MM Film".
 */
function movieBuckets(watches: readonly Watch[]): Bucket[] {
  const entries = watches.map((w) => ({
    watch: w,
    title: cleanMovieTitle(displayTitle(w), w.showtime.experience_types),
  }));

  const canonical = unionNearMatches(entries.map((e) => e.title.key));

  const buckets = new Map<string, { cleans: string[]; watches: Watch[] }>();
  for (const entry of entries) {
    const root = rootKeyOf(entry.title, canonical);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = { cleans: [], watches: [] };
      buckets.set(root, bucket);
    }
    bucket.cleans.push(entry.title.clean);
    bucket.watches.push(entry.watch);
  }

  return [...buckets.entries()].map(([root, bucket]) => {
    const cleans = [...bucket.cleans].sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    );
    return {
      key: `movie:${root}`,
      label: cleans[0] ?? UNTITLED,
      isFallback: false,
      watches: bucket.watches,
    };
  });
}

/**
 * A title of nothing but punctuation normalizes to an empty key, which
 * `unionNearMatches` drops. Give it a stable bucket of its own rather than
 * letting every such watch collapse together with a blank key.
 */
function rootKeyOf(title: CleanTitle, canonical: Map<string, string>): string {
  if (title.key.length > 0) return canonical.get(title.key) ?? title.key;
  return `untitled:${title.clean.toLowerCase()}`;
}

function dateBuckets(watches: readonly Watch[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const w of watches) {
    const day = dayOf(w);
    const key = day === null ? "date:none" : `date:${day.key}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: day === null ? "No date set" : formatDay(day.date),
        isFallback: day === null,
        watches: [],
      };
      buckets.set(key, bucket);
    }
    bucket.watches.push(w);
  }
  return [...buckets.values()];
}

function theatreBuckets(watches: readonly Watch[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const w of watches) {
    const name = theatreNameOf(w);
    const key = name === null ? "theatre:none" : `theatre:${theatreKeyOf(name)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: name ?? "Theatre unknown",
        isFallback: name === null,
        watches: [],
      };
      buckets.set(key, bucket);
    }
    bucket.watches.push(w);
  }
  return [...buckets.values()];
}

/**
 * Group by presentation format.
 *
 * A showtime with no format tokens is either a genuinely standard screening or
 * one whose metadata never resolved, and the two deserve different labels —
 * `movie_name === null` is what tells them apart, since a resolved showtime that
 * reports no formats really is 2D. Both sort last: neither is a format anyone
 * chose.
 */
function formatBuckets(watches: readonly Watch[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const w of watches) {
    const tokens = formatTokensOf(w);
    let key: string;
    let label: string;
    let isFallback: boolean;
    if (tokens.length > 0) {
      key = `format:${formatSignatureOf(tokens)}`;
      label = formatLabelOf(tokens);
      isFallback = false;
    } else if (w.showtime.movie_name === null) {
      key = "format:unknown";
      label = "Format unknown";
      isFallback = true;
    } else {
      key = "format:standard";
      label = "Standard";
      isFallback = true;
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, isFallback, watches: [] };
      buckets.set(key, bucket);
    }
    bucket.watches.push(w);
  }
  return [...buckets.values()];
}

function bucketsFor(watches: readonly Watch[], groupBy: GroupBy): Bucket[] {
  switch (groupBy) {
    case "movie":
      return movieBuckets(watches);
    case "date":
      return dateBuckets(watches);
    case "theatre":
      return theatreBuckets(watches);
    case "format":
      return formatBuckets(watches);
    case "none":
      return [
        {
          key: "all",
          label: "All watches",
          isFallback: false,
          watches: [...watches],
        },
      ];
  }
}

// --- ordering --------------------------------------------------------------

function activeRank(w: Watch): number {
  return w.status === "active" ? 0 : 1;
}

/**
 * Order watches inside a group: active first, then the caller's choice.
 *
 * Active-first is a no-op inside the Active and Expired tabs and keeps the All
 * tab behaving as it does today, so no mode-switching is needed. Every branch
 * falls through to newest-first and then to the id, so the order is total and
 * does not depend on the input's arrangement.
 */
function compareWatches(a: Watch, b: Watch, sortBy: SortBy): number {
  const active = activeRank(a) - activeRank(b);
  if (active !== 0) return active;

  switch (sortBy) {
    case "showtime": {
      const at = timeValueOf(a);
      const bt = timeValueOf(b);
      if (at === null || bt === null) {
        // Undated watches sink; two undated ones fall through to the tiebreak.
        if (at !== bt) return at === null ? 1 : -1;
      } else if (at !== bt) {
        return at - bt;
      }
      break;
    }
    case "added":
      break;
    case "name": {
      const c = displayTitle(a).localeCompare(displayTitle(b), undefined, {
        numeric: true,
      });
      if (c !== 0) return c;
      break;
    }
    case "format": {
      const al = formatLabelOf(formatTokensOf(a));
      const bl = formatLabelOf(formatTokensOf(b));
      if ((al === "") !== (bl === "")) return al === "" ? 1 : -1;
      const c = al.localeCompare(bl);
      if (c !== 0) return c;
      break;
    }
    case "theatre": {
      const an = theatreNameOf(a);
      const bn = theatreNameOf(b);
      if ((an === null) !== (bn === null)) return an === null ? 1 : -1;
      if (an !== null && bn !== null) {
        const c = an.localeCompare(bn);
        if (c !== 0) return c;
      }
      break;
    }
  }

  const created = createdValueOf(b) - createdValueOf(a);
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

/**
 * Order the groups themselves.
 *
 * Deliberately fixed and mode-intrinsic: the user's Sort-by applies *within* a
 * group, not between them. Groups holding a live watch lead (preserving today's
 * active-first list), fallback buckets sink, and the rest is alphabetical —
 * except dates, which are chronological. Date keys are `date:YYYY-MM-DD`, so a
 * string compare is already chronological.
 */
function compareGroups(a: WatchGroup, b: WatchGroup, groupBy: GroupBy): number {
  const aLive = a.activeCount > 0 ? 0 : 1;
  const bLive = b.activeCount > 0 ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive;

  if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;

  if (groupBy === "date") {
    const c = a.key.localeCompare(b.key);
    if (c !== 0) return c;
  }

  const byLabel = a.label.localeCompare(b.label, undefined, { numeric: true });
  if (byLabel !== 0) return byLabel;
  return a.key.localeCompare(b.key);
}

// --- entry point -----------------------------------------------------------

const EMPTY_STATUS_COUNTS: Record<WatchStatus, number> = {
  active: 0,
  fulfilled: 0,
  cancelled: 0,
  expired: 0,
};

/**
 * Collapse a watch list into groups.
 *
 * The caller filters by status first, so group counts always match what is on
 * screen. Sorting happens twice: `sortBy` inside each group, and a fixed
 * mode-intrinsic order between them.
 */
export function groupWatches(
  watches: Watch[],
  groupBy: GroupBy,
  sortBy: SortBy,
): WatchGroup[] {
  const groups = bucketsFor(watches, groupBy).map((bucket) => {
    const statusCounts = { ...EMPTY_STATUS_COUNTS };
    let seatCount = 0;
    let notifiedCount = 0;
    for (const w of bucket.watches) {
      statusCounts[w.status] += 1;
      seatCount += w.seats.length;
      for (const seat of w.seats) {
        if (seat.notified_at !== null) notifiedCount += 1;
      }
    }
    const sorted = [...bucket.watches].sort((a, b) =>
      compareWatches(a, b, sortBy),
    );
    return {
      key: bucket.key,
      label: bucket.label,
      watches: sorted,
      facets: buildFacets(sorted, groupBy),
      seatCount,
      notifiedCount,
      activeCount: statusCounts.active,
      statusCounts,
      isFallback: bucket.isFallback,
    };
  });

  return groups.sort((a, b) => compareGroups(a, b, groupBy));
}
