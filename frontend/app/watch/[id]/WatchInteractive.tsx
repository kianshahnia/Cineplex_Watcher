"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  MAX_FANOUT_TARGETS,
  addSeatsToWatch,
  cancelWatch,
  createWatch,
  fanoutWatches,
  getMe,
  getShowtimeAlternatives,
  getShowtimeSeats,
  listWatches,
  updateWatch,
} from "@/lib/api";
import type {
  CurrentUser,
  FanoutTarget,
  SeatMapLayout,
  SeatToWatch,
  ShowtimeWithSeats,
  SiblingShowtimes,
  Watch,
} from "@/lib/api";
import { SeatMap } from "../../components/SeatMap";
import {
  useShowtimeEvents,
  type ShowtimeEvent,
} from "@/hooks/useShowtimeEvents";
import {
  ShowtimeSwitcher,
  formatDay,
  formatTime,
  type SwitcherOption,
} from "./ShowtimeSwitcher";
import { WatchHeader } from "./WatchHeader";
import {
  groupedSelections,
  loadWorkingSet,
  saveWorkingSet,
  unionPicks,
  type SelectionMap,
  type SelectionMode,
} from "@/lib/watchSelection";
import styles from "./WatchInteractive.module.css";
import pageStyles from "./WatchPage.module.css";

/**
 * Stable identity for "this showtime has no picks", so memos don't churn.
 * Shared by every empty lookup — never mutate it.
 */
const NO_SEATS: Set<string> = new Set<string>();
const NO_FREE: ReadonlyMap<string, string[]> = new Map();

type AuthState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | {
      kind: "signed-in";
      user: CurrentUser;
      /** Active watches at this theatre, keyed by Cineplex showtime id. */
      watches: Map<number, Watch>;
    };

/** One line of the post-submit outcome list (plan §4.3). */
interface ResultLine {
  showtime_id: number;
  ok: boolean;
  text: string;
  alreadyAvailable: string[];
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  // Single-showtime submit — unchanged copy from before the switcher existed.
  | { kind: "ok"; watch: Watch }
  // Multi-showtime submit — one line per showtime touched.
  | { kind: "report"; lines: ResultLine[] }
  | { kind: "error"; message: string };

interface Props {
  initial: ShowtimeWithSeats;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const FLASH_DURATION_MS = 2400;

/** Structurally-sharing status flip: only the changed row/seat is reallocated. */
function applySeatEvent(
  layout: SeatMapLayout,
  seatKey: string,
  newStatus: string,
): { layout: SeatMapLayout; changed: boolean } {
  let changed = false;
  const rows = layout.rows.map((row) => {
    let touched = false;
    const seats = row.seats.map((seat) => {
      if (seat.id !== seatKey || seat.status === newStatus) return seat;
      touched = true;
      changed = true;
      return { ...seat, status: newStatus };
    });
    return touched ? { ...row, seats } : row;
  });
  return changed
    ? { layout: { ...layout, rows }, changed: true }
    : { layout, changed: false };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Seat labels in human order: G2 before G10, not after it. */
function sortLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WatchInteractive({ initial }: Props): JSX.Element {
  const { theatre_id, showtime_id: anchorId } = initial.showtime;

  // --- multi-showtime seat data ------------------------------------------
  // Lazily filled as the user visits tabs (per-showtime mode) or ticks times
  // (grouped mode). No batch endpoint: siblings share an identical layout, so a
  // `…/group` call is the obvious optimization if this ever feels slow — a
  // handful of calls against a 30/min-per-IP limit is comfortable.
  const [seatData, setSeatData] = useState<Map<number, ShowtimeWithSeats>>(
    () => new Map([[anchorId, initial]]),
  );
  const [viewing, setViewing] = useState<number>(anchorId);
  const [loadingIds, setLoadingIds] = useState<Set<number>>(() => new Set());
  const [loadErrors, setLoadErrors] = useState<Map<number, string>>(
    () => new Map(),
  );

  // --- selection mode -----------------------------------------------------
  const [mode, setMode] = useState<SelectionMode>("per-showtime");
  const [ticked, setTicked] = useState<Set<number>>(() => new Set());
  const [normalizeNotice, setNormalizeNotice] = useState<string | null>(null);
  const grouped = mode === "grouped";

  // Refresh the anchor's entry if the server re-renders the page, without
  // dropping the sibling tabs the user has already opened.
  useEffect(() => {
    setSeatData((prev) => {
      const next = new Map(prev);
      next.set(initial.showtime.showtime_id, initial);
      return next;
    });
  }, [initial]);

  const viewed = seatData.get(viewing) ?? null;
  const isAnchorView = viewing === anchorId;
  // Grouped mode paints one map for several showtimes. Siblings share an
  // identical layout (that identity is the whole feature), and the anchor's is
  // the one guaranteed to be loaded, so it is the stand-in.
  const baseLayout = seatData.get(anchorId)?.layout ?? initial.layout;

  // --- sibling showtimes --------------------------------------------------
  const [siblings, setSiblings] = useState<SiblingShowtimes | null>(null);
  // Distinct from `siblings !== null`: a failed lookup also settles the question
  // of whether this page has a switcher at all.
  const [siblingsResolved, setSiblingsResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const set = await getShowtimeAlternatives(theatre_id, anchorId);
        if (!cancelled) setSiblings(set);
      } catch {
        // Metadata-class feature: degrade silently. No switcher is exactly what
        // a single-showing film renders, so there is nothing to report.
      } finally {
        if (!cancelled) setSiblingsResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [theatre_id, anchorId]);

  // Which showtimes have already been asked for. A ref rather than deriving it
  // from `seatData`, because that map is also rewritten by live seat events —
  // keying the fetch effect off it would restart an in-flight request every time
  // an unrelated seat flipped, and upstream request volume is the one budget
  // this project cannot overspend.
  const requestedRef = useRef<Set<number>>(new Set([anchorId]));

  // What needs seat data right now. Deliberately built from `mode` / `ticked` /
  // `viewing` only — all stable across a pick — so the fetch effect below never
  // re-runs because a chip's badge changed.
  const wantedIds = useMemo<number[]>(
    () => (grouped ? [...ticked] : [viewing]),
    [grouped, ticked, viewing],
  );

  // Fetch each showtime's seat data the first time it's needed. Grouped mode
  // asks for every ticked time at once and the markers fill in progressively.
  useEffect(() => {
    const pending = wantedIds.filter((id) => !requestedRef.current.has(id));
    if (pending.length === 0) return;
    for (const id of pending) requestedRef.current.add(id);
    setLoadingIds((prev) => {
      const next = new Set(prev);
      for (const id of pending) next.add(id);
      return next;
    });
    setLoadErrors((prev) => {
      if (!pending.some((id) => prev.has(id))) return prev;
      const next = new Map(prev);
      for (const id of pending) next.delete(id);
      return next;
    });

    // Errors are keyed by showtime rather than tracked against "is this still
    // the tab I'm on", so there is no stale-closure question: a completed fetch
    // always records its own outcome, and the UI reads whichever it needs.
    void Promise.all(
      pending.map(async (id) => {
        try {
          const data = await getShowtimeSeats(theatre_id, id);
          // Cached even if the user has moved on — the tab they left is one they
          // are likely to come back to, and the request is already paid for.
          setSeatData((prev) => new Map(prev).set(id, data));
        } catch (err) {
          requestedRef.current.delete(id); // revisiting retries
          const message = errorMessage(err, "Couldn't load that showtime.");
          setLoadErrors((prev) => new Map(prev).set(id, message));
        } finally {
          setLoadingIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }),
    );
  }, [wantedIds, theatre_id]);

  // --- selection ----------------------------------------------------------
  const [selections, setSelections] = useState<SelectionMap>(() => new Map());
  const [notifyAnySeat, setNotifyAnySeat] = useState<boolean>(false);
  // The user's personal label for this watch, edited by clicking the page
  // title. Sent along with the create call; PATCHed in place afterwards.
  const [name, setName] = useState<string>("");
  const [nameSaving, setNameSaving] = useState<boolean>(false);

  // hydrate from localStorage on mount
  useEffect(() => {
    const stored = loadWorkingSet(theatre_id, anchorId);
    if (stored.selections.size > 0) setSelections(stored.selections);
    if (stored.ticked.size > 0) setTicked(stored.ticked);
    if (stored.mode === "grouped") setMode("grouped");
  }, [theatre_id, anchorId]);

  // persist on every change
  useEffect(() => {
    saveWorkingSet(theatre_id, anchorId, { selections, ticked, mode });
  }, [selections, ticked, mode, theatre_id, anchorId]);

  // Once the sibling set is known, drop picks and ticks for showtimes that are
  // no longer part of it. Cineplex re-schedules, and a stale restored blob would
  // otherwise inflate the CTA's count forever and send targets the server can
  // only refuse.
  useEffect(() => {
    if (!siblings) return;
    const valid = new Set<number>([
      anchorId,
      ...siblings.alternatives.map((a) => a.showtime_id),
    ]);
    const prune = (
      keys: Iterable<number>,
      drop: (id: number) => void,
    ): boolean => {
      let changed = false;
      for (const id of keys) {
        if (!valid.has(id)) {
          drop(id);
          changed = true;
        }
      }
      return changed;
    };
    setSelections((prev) => {
      const out = new Map(prev);
      return prune(prev.keys(), (id) => out.delete(id)) ? out : prev;
    });
    setTicked((prev) => {
      const out = new Set(prev);
      return prune(prev, (id) => out.delete(id)) ? out : prev;
    });
  }, [siblings, anchorId]);

  // --- auth + existing watches -------------------------------------------
  const indexWatches = useCallback(
    (watches: Watch[]): Map<number, Watch> => {
      const map = new Map<number, Watch>();
      for (const w of watches) {
        if (w.showtime.theatre_id === theatre_id) {
          map.set(w.showtime.showtime_id, w);
        }
      }
      return map;
    },
    [theatre_id],
  );

  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  const refreshAuth = useCallback(async () => {
    setAuth({ kind: "loading" });
    try {
      const user = await getMe();
      if (!user) {
        setAuth({ kind: "signed-out" });
        return;
      }
      let watches = new Map<number, Watch>();
      try {
        watches = indexWatches(await listWatches("active"));
      } catch {
        // A watch-list failure shouldn't sign the user out; they can still pick.
      }
      setAuth({ kind: "signed-in", user, watches });
      const anchorWatch = watches.get(anchorId);
      if (anchorWatch) {
        setNotifyAnySeat(anchorWatch.notify_any_seat);
        setName(anchorWatch.name ?? "");
      }
    } catch {
      setAuth({ kind: "signed-out" });
    }
  }, [indexWatches, anchorId]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  /** Re-read the watch list without flashing the panel back to "loading". */
  const refreshWatches = useCallback(async () => {
    try {
      const watches = indexWatches(await listWatches("active"));
      setAuth((prev) =>
        prev.kind === "signed-in" ? { ...prev, watches } : prev,
      );
    } catch {
      // keep whatever we already have
    }
  }, [indexWatches]);

  // --- live event stream --------------------------------------------------
  // Flash keys are `{showtimeId}:{seatKey}` because seat keys repeat across
  // siblings by design — an unqualified key would flash the wrong tab's seat.
  const [flashKeys, setFlashKeys] = useState<Set<string>>(() => new Set());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const onLiveEvent = useCallback((event: ShowtimeEvent): void => {
    if (event.type !== "seat_available") return;
    const { seat_key, showtime_id: eventShowtimeId } = event;

    // 1. Flip the seat status in whichever cached showtime it belongs to.
    setSeatData((prev) => {
      const entry = prev.get(eventShowtimeId);
      if (!entry) return prev;
      const { layout, changed } = applySeatEvent(
        entry.layout,
        seat_key,
        "Available",
      );
      if (!changed) return prev;
      return new Map(prev).set(eventShowtimeId, { ...entry, layout });
    });

    // 2. Mark the seat as flashing (auto-clears after FLASH_DURATION_MS).
    const flashKey = `${eventShowtimeId}:${seat_key}`;
    setFlashKeys((prev) => {
      if (prev.has(flashKey)) return prev;
      const next = new Set(prev);
      next.add(flashKey);
      return next;
    });
    const prevTimer = flashTimersRef.current.get(flashKey);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      setFlashKeys((prev) => {
        if (!prev.has(flashKey)) return prev;
        const next = new Set(prev);
        next.delete(flashKey);
        return next;
      });
      flashTimersRef.current.delete(flashKey);
    }, FLASH_DURATION_MS);
    flashTimersRef.current.set(flashKey, timer);
  }, []);

  // Clear timers on unmount.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // The subscription follows the *viewed* showtime: leaving it on the anchor
  // would paint live updates onto a map the user isn't looking at, and show
  // none on the one they are. Grouped mode has no live colours to update, so it
  // holds no socket at all — a flashing seat there would be claiming a status
  // the map is deliberately not stating.
  useShowtimeEvents({
    showtimeUuid: grouped ? null : (viewed?.showtime.id ?? null),
    enabled:
      !grouped &&
      Boolean(viewed?.showtime.is_active) &&
      !viewed?.is_post_showtime,
    onEvent: onLiveEvent,
  });

  // --- derived data -------------------------------------------------------

  /** seat key → label, per showtime. Siblings share keys, so the anchor's map
   *  is a valid fallback for a showtime whose tab was never opened. */
  const seatLabels = useMemo<Map<number, Map<string, string>>>(() => {
    const out = new Map<number, Map<string, string>>();
    for (const [id, data] of seatData) {
      const labels = new Map<string, string>();
      for (const row of data.layout.rows) {
        for (const seat of row.seats) labels.set(seat.id, seat.label);
      }
      out.set(id, labels);
    }
    return out;
  }, [seatData]);

  const labelFor = useCallback(
    (showtimeId: number, seatKey: string): string =>
      seatLabels.get(showtimeId)?.get(seatKey) ??
      seatLabels.get(anchorId)?.get(seatKey) ??
      seatKey,
    [seatLabels, anchorId],
  );

  /** Committed seat keys, per showtime. */
  const watchedByShowtime = useMemo<Map<number, Set<string>>>(() => {
    const out = new Map<number, Set<string>>();
    if (auth.kind !== "signed-in") return out;
    for (const [id, watch] of auth.watches) {
      out.set(id, new Set(watch.seats.map((s) => s.seat_key)));
    }
    return out;
  }, [auth]);

  /** Picks that aren't already committed, per showtime. */
  const pendingByShowtime = useMemo<Map<number, string[]>>(() => {
    const out = new Map<number, string[]>();
    for (const [id, picks] of selections) {
      const watched = watchedByShowtime.get(id) ?? NO_SEATS;
      const pending = [...picks].filter((seatId) => !watched.has(seatId));
      if (pending.length > 0) out.set(id, pending);
    }
    return out;
  }, [selections, watchedByShowtime]);

  const anchorWatch =
    auth.kind === "signed-in" ? (auth.watches.get(anchorId) ?? null) : null;
  const viewedWatch =
    auth.kind === "signed-in" ? (auth.watches.get(viewing) ?? null) : null;

  const flashIds = useMemo<Set<string>>(() => {
    const prefix = `${viewing}:`;
    const out = new Set<string>();
    for (const key of flashKeys) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
    }
    return out;
  }, [flashKeys, viewing]);

  // --- switcher options ---------------------------------------------------
  const switcherOptions = useMemo<SwitcherOption[]>(() => {
    const anchorOption: SwitcherOption = {
      showtime_id: anchorId,
      showtime_local:
        initial.showtime.showtime_local ?? siblings?.showtime_local ?? null,
      isAnchor: true,
      picked: pendingByShowtime.get(anchorId)?.length ?? 0,
      watching: anchorWatch !== null,
      isSoldOut: initial.is_sold_out,
    };
    const rest: SwitcherOption[] = (siblings?.alternatives ?? []).map((alt) => ({
      showtime_id: alt.showtime_id,
      showtime_local: alt.showtime_local,
      isAnchor: false,
      picked: pendingByShowtime.get(alt.showtime_id)?.length ?? 0,
      watching:
        auth.kind === "signed-in" && auth.watches.has(alt.showtime_id),
      isSoldOut: alt.is_sold_out,
    }));

    // Chronological, undated last — the backend already sorts the siblings, but
    // the anchor has to be merged into that order.
    return [anchorOption, ...rest].sort((a, b) => {
      if (!a.showtime_local) return 1;
      if (!b.showtime_local) return -1;
      return a.showtime_local.localeCompare(b.showtime_local);
    });
  }, [anchorId, initial, siblings, pendingByShowtime, anchorWatch, auth]);

  const timeLabelFor = useCallback(
    (showtimeId: number): string => {
      const opt = switcherOptions.find((o) => o.showtime_id === showtimeId);
      return formatTime(opt?.showtime_local ?? null) ?? `#${showtimeId}`;
    },
    [switcherOptions],
  );

  const hasSwitcher = switcherOptions.length > 1;

  // A restored "grouped" mode with no switcher to leave it would be a trap: the
  // toggle is inside the switcher. Self-correct once the sibling set settles.
  useEffect(() => {
    if (siblingsResolved && !hasSwitcher && grouped) {
      setMode("per-showtime");
      setNormalizeNotice(null);
    }
  }, [siblingsResolved, hasSwitcher, grouped]);

  // --- grouped-mode derived data -----------------------------------------

  const tickedIds = useMemo<number[]>(
    () =>
      switcherOptions
        .filter((o) => ticked.has(o.showtime_id))
        .map((o) => o.showtime_id),
    [switcherOptions, ticked],
  );

  /** The shared set every ticked showtime holds. */
  const groupedSelected = useMemo<Set<string>>(
    () => (grouped ? unionPicks(selections, ticked) : NO_SEATS),
    [grouped, selections, ticked],
  );

  /**
   * Locked seats in grouped mode = committed at **every** ticked showtime. One
   * that's watched at only some stays selectable, so the user can fill the gaps
   * (plan §6.3).
   */
  const groupedWatched = useMemo<Set<string>>(() => {
    if (!grouped || tickedIds.length === 0) return NO_SEATS;
    let acc: Set<string> | null = null;
    for (const id of tickedIds) {
      const watched = watchedByShowtime.get(id) ?? NO_SEATS;
      if (acc === null) {
        acc = new Set(watched);
        continue;
      }
      for (const seatId of [...acc]) {
        if (!watched.has(seatId)) acc.delete(seatId);
      }
      if (acc.size === 0) break;
    }
    return acc ?? NO_SEATS;
  }, [grouped, tickedIds, watchedByShowtime]);

  /**
   * Seat id → the ticked times where it is already Available. The one status
   * fact that survives the neutral map, because it is true no matter which
   * showtime you have in mind. Built only from tabs already fetched, so the
   * markers appear progressively as the parallel fetches land.
   */
  const freeAt = useMemo<ReadonlyMap<string, string[]>>(() => {
    if (!grouped) return NO_FREE;
    const out = new Map<string, string[]>();
    for (const id of tickedIds) {
      const data = seatData.get(id);
      if (!data) continue;
      const label = timeLabelFor(id);
      for (const row of data.layout.rows) {
        for (const seat of row.seats) {
          if (seat.status !== "Available") continue;
          const at = out.get(seat.id);
          if (at) {
            at.push(label);
          } else {
            out.set(seat.id, [label]);
          }
        }
      }
    }
    return out;
  }, [grouped, tickedIds, seatData, timeLabelFor]);

  // --- what the action panel shows ---------------------------------------

  const viewedSelection = selections.get(viewing) ?? NO_SEATS;
  const viewedWatchedIds = watchedByShowtime.get(viewing) ?? NO_SEATS;
  const viewedPending = useMemo<string[]>(
    () => pendingByShowtime.get(viewing) ?? [],
    [pendingByShowtime, viewing],
  );

  const groupedPending = useMemo<string[]>(
    () => [...groupedSelected].filter((id) => !groupedWatched.has(id)),
    [groupedSelected, groupedWatched],
  );

  const panelPendingLabels = useMemo<string[]>(() => {
    const [scope, ids] = grouped
      ? [anchorId, groupedPending]
      : [viewing, viewedPending];
    return sortLabels(ids.map((id) => labelFor(scope, id)));
  }, [grouped, anchorId, groupedPending, viewing, viewedPending, labelFor]);

  const panelWatchedLabels = useMemo<string[]>(() => {
    if (grouped) {
      return sortLabels([...groupedWatched].map((id) => labelFor(anchorId, id)));
    }
    return sortLabels(viewedWatch?.seats.map((s) => s.seat_label) ?? []);
  }, [grouped, groupedWatched, labelFor, anchorId, viewedWatch]);

  // --- work summary -------------------------------------------------------
  const totalPendingSeats = useMemo<number>(() => {
    let total = 0;
    for (const pending of pendingByShowtime.values()) total += pending.length;
    return total;
  }, [pendingByShowtime]);

  const showtimesWithPicks = pendingByShowtime.size;
  // "Watch all seats" is a create-time flag on a single watch, and the fan-out
  // endpoint carries one shared flag for the whole batch — so it stays scoped to
  // the anchor. Siblings are seat-pick driven.
  const anchorWatchAllWork = anchorWatch === null && notifyAnySeat;

  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const canSubmit =
    auth.kind === "signed-in" &&
    submit.kind !== "submitting" &&
    (totalPendingSeats > 0 || anchorWatchAllWork);

  // --- interaction --------------------------------------------------------

  const clearSubmitNotice = useCallback((): void => {
    setSubmit((s) =>
      s.kind !== "idle" && s.kind !== "submitting" ? { kind: "idle" } : s,
    );
  }, []);

  const viewedIsAll = viewedWatch?.notify_any_seat === true;

  // Set one seat's picked state. `select` is decided by the SeatMap: a click
  // toggles, a drag paints every crossed seat to the same value. In per-showtime
  // mode the pick lands on the tab being viewed; in grouped mode it lands on
  // every ticked showtime at once.
  const onPaintSeat = useCallback(
    (seatId: string, select: boolean): void => {
      if (grouped) {
        if (ticked.size === 0) return;
        setSelections((prev) => {
          const out = new Map(prev);
          let changed = false;
          for (const id of ticked) {
            // Already committed here — nothing to add, and nothing a deselect
            // could take away (per-seat delete needs a backend endpoint).
            if ((watchedByShowtime.get(id) ?? NO_SEATS).has(seatId)) continue;
            const current = out.get(id) ?? NO_SEATS;
            if (current.has(seatId) === select) continue;
            const next = new Set(current);
            if (select) {
              next.add(seatId);
            } else {
              next.delete(seatId);
            }
            changed = true;
            if (next.size === 0) {
              out.delete(id);
            } else {
              out.set(id, next);
            }
          }
          return changed ? out : prev;
        });
        setNormalizeNotice(null);
        clearSubmitNotice();
        return;
      }

      if (viewedWatchedIds.has(seatId)) return;
      // An existing "watch all seats" watch is locked — picking is a no-op.
      if (viewedIsAll) return;
      // Picking a specific seat on a new anchor watch exits "watch all" mode;
      // the two are mutually exclusive so the summary stays unambiguous.
      if (select && isAnchorView && anchorWatchAllWork) setNotifyAnySeat(false);

      setSelections((prev) => {
        const current = prev.get(viewing) ?? NO_SEATS;
        if (current.has(seatId) === select) return prev; // already in target state
        const next = new Set(current);
        if (select) {
          next.add(seatId);
        } else {
          next.delete(seatId);
        }
        const out = new Map(prev);
        if (next.size === 0) {
          out.delete(viewing);
        } else {
          out.set(viewing, next);
        }
        return out;
      });
      clearSubmitNotice();
    },
    [
      grouped,
      ticked,
      watchedByShowtime,
      viewedWatchedIds,
      viewedIsAll,
      isAnchorView,
      anchorWatchAllWork,
      viewing,
      clearSubmitNotice,
    ],
  );

  const onToggleWatchAll = useCallback((): void => {
    if (anchorWatch !== null) return;
    setNotifyAnySeat((prev) => {
      const next = !prev;
      // "Watch all seats" makes the anchor's individual picks redundant — clear
      // them so the summary and the submit payload are unambiguous. Sibling
      // picks are untouched; they're separate watches.
      if (next) {
        setSelections((sel) => {
          if (!sel.has(anchorId)) return sel;
          const out = new Map(sel);
          out.delete(anchorId);
          return out;
        });
      }
      return next;
    });
    clearSubmitNotice();
  }, [anchorWatch, anchorId, clearSubmitNotice]);

  const onClearSelection = useCallback((): void => {
    setSelections((prev) => {
      const scope = grouped ? [...ticked] : [viewing];
      if (!scope.some((id) => prev.has(id))) return prev;
      const out = new Map(prev);
      for (const id of scope) out.delete(id);
      return out;
    });
    setNormalizeNotice(null);
    clearSubmitNotice();
  }, [grouped, ticked, viewing, clearSubmitNotice]);

  const onView = useCallback(
    (showtimeId: number): void => {
      setViewing(showtimeId);
      clearSubmitNotice();
    },
    [clearSubmitNotice],
  );

  /**
   * Switching to grouped mode **normalizes**: the union of every ticked
   * showtime's picks becomes the shared set and is applied to all of them. That
   * is what makes the toggle mean something concrete rather than silently
   * showing a union that only half-applies — and it makes switching back
   * lossless, because the per-showtime map now genuinely holds those seats
   * everywhere.
   */
  const onModeChange = useCallback(
    (next: SelectionMode): void => {
      if (next === mode) return;
      clearSubmitNotice();

      if (next === "grouped") {
        // Default to every showing in the set. "Same seats for all" taken
        // literally; the tick boxes are there to narrow it.
        const ids =
          ticked.size > 0
            ? new Set(tickedIds)
            : new Set(switcherOptions.map((o) => o.showtime_id));
        const shared = unionPicks(selections, ids);
        setTicked(ids);
        setSelections(groupedSelections(ids, shared));
        setNormalizeNotice(
          shared.size > 0
            ? `Applied your ${plural(shared.size, "pick")} to all ${ids.size} times.`
            : null,
        );
        // Picking specific seats and "watch all seats" are mutually exclusive,
        // and grouped mode is explicitly the former.
        if (anchorWatch === null) setNotifyAnySeat(false);
      } else {
        setNormalizeNotice(null);
      }
      setMode(next);
    },
    [
      mode,
      ticked,
      tickedIds,
      switcherOptions,
      selections,
      anchorWatch,
      clearSubmitNotice,
    ],
  );

  /** Add or remove a showtime from the grouped batch, keeping the invariant. */
  const onToggleTicked = useCallback(
    (showtimeId: number): void => {
      const next = new Set(ticked);
      if (next.has(showtimeId)) {
        next.delete(showtimeId);
      } else {
        next.add(showtimeId);
      }
      setTicked(next);
      // The shared set comes from the *previous* ticked set, so unticking the
      // only showtime that had picks doesn't erase them for the rest.
      setSelections((prev) => groupedSelections(next, unionPicks(prev, ticked)));
      setNormalizeNotice(null);
      clearSubmitNotice();
    },
    [ticked, clearSubmitNotice],
  );

  // --- submission ---------------------------------------------------------

  const onSubmit = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in") return;
    setSubmit({ kind: "submitting" });

    const trimmedName = name.trim() || null;
    const anchorPending = pendingByShowtime.get(anchorId) ?? [];
    // The anchor keeps its original create/add path: it carries the 409 handling,
    // the `notify_any_seat` flag, and the header's rename target. Only the other
    // showtimes go through fan-out.
    const fanoutTargets: FanoutTarget[] = [];
    for (const [showtimeId, pending] of pendingByShowtime) {
      if (showtimeId === anchorId) continue;
      const seats: SeatToWatch[] = pending.map((seatId) => ({
        seat_key: seatId,
        seat_label: labelFor(showtimeId, seatId),
      }));
      fanoutTargets.push({ showtime_id: showtimeId, seats });
    }
    // The backend rejects an over-cap batch outright (422), so trim here and
    // leave the remainder picked — the user can submit again for the rest.
    const targets = fanoutTargets.slice(0, MAX_FANOUT_TARGETS);

    const lines: ResultLine[] = [];
    const committed: number[] = [];
    let anchorWatchResult: Watch | null = null;
    let anchorError: string | null = null;

    // --- anchor ----------------------------------------------------------
    if (anchorPending.length > 0 || anchorWatchAllWork) {
      try {
        let watch = anchorWatch;
        if (!watch) {
          watch = await createWatch({
            theatre_id,
            showtime_id: anchorId,
            notify_any_seat: notifyAnySeat,
            name: trimmedName,
          });
        }
        if (anchorPending.length > 0) {
          watch = await addSeatsToWatch(
            watch.id,
            anchorPending.map((seatId) => ({
              seat_key: seatId,
              seat_label: labelFor(anchorId, seatId),
            })),
          );
        }
        anchorWatchResult = watch;
        committed.push(anchorId);
        lines.push({
          showtime_id: anchorId,
          ok: true,
          text: watch.notify_any_seat
            ? "Watching every seat"
            : `Watching ${plural(watch.seats.length, "seat")}`,
          alreadyAvailable: [],
        });
      } catch (err) {
        anchorError = errorMessage(
          err,
          "Couldn't save your watch. Try again in a moment.",
        );
        lines.push({
          showtime_id: anchorId,
          ok: false,
          text: anchorError,
          alreadyAvailable: [],
        });
      }
    }

    // --- siblings --------------------------------------------------------
    let fanoutError: string | null = null;
    if (targets.length > 0) {
      try {
        const results = await fanoutWatches({
          theatre_id,
          source_showtime_id: anchorId,
          targets,
          notify_any_seat: false,
          name: trimmedName,
        });
        for (const r of results) {
          const applied =
            r.status === "created" ||
            r.status === "updated" ||
            r.status === "reactivated";
          if (applied) committed.push(r.showtime_id);
          lines.push({
            showtime_id: r.showtime_id,
            ok: applied,
            text: applied
              ? `Watching ${plural(r.seats_applied, "seat")}`
              : (r.message ?? "Couldn't add this showtime."),
            alreadyAvailable: r.already_available,
          });
        }
      } catch (err) {
        // The whole call was rejected (auth, rate limit, validation) — every
        // target is untouched, so report them all as retryable.
        fanoutError = errorMessage(
          err,
          "Couldn't save the other showtimes. Try again in a moment.",
        );
        for (const t of targets) {
          lines.push({
            showtime_id: t.showtime_id,
            ok: false,
            text: fanoutError,
            alreadyAvailable: [],
          });
        }
      }
    }

    // --- settle state ----------------------------------------------------
    // Only successful showtimes give up their picks, so pressing submit again
    // retries exactly what failed and nothing else.
    if (committed.length > 0) {
      setSelections((prev) => {
        const out = new Map(prev);
        for (const id of committed) out.delete(id);
        return out;
      });
      setNormalizeNotice(null);
    }

    if (anchorWatchResult) {
      const updated = anchorWatchResult;
      setAuth((prev) =>
        prev.kind === "signed-in"
          ? {
              ...prev,
              watches: new Map(prev.watches).set(anchorId, updated),
            }
          : prev,
      );
    }
    // Fan-out only hands back ids and counts, so re-read the list to keep the
    // committed-seat overlays honest on every tab.
    if (targets.length > 0 && !fanoutError) {
      await refreshWatches();
    }

    if (lines.length === 0) {
      setSubmit({ kind: "idle" });
    } else if (lines.length === 1 && anchorWatchResult) {
      // Single-showtime submit — keep the pre-switcher copy exactly as it was.
      setSubmit({ kind: "ok", watch: anchorWatchResult });
    } else if (lines.length === 1 && !lines[0]?.ok) {
      setSubmit({
        kind: "error",
        message: anchorError ?? fanoutError ?? lines[0]?.text ?? "Try again.",
      });
    } else {
      setSubmit({ kind: "report", lines });
    }
  }, [
    auth,
    name,
    pendingByShowtime,
    anchorId,
    anchorWatch,
    anchorWatchAllWork,
    notifyAnySeat,
    labelFor,
    theatre_id,
    refreshWatches,
  ]);

  /**
   * Commit a new label from the click-to-edit page title.
   *
   * Before the watch exists there is nothing to PATCH — the name is held
   * locally and rides along with `createWatch` on submit. Afterwards it's a
   * PATCH in place. **Rethrows on failure** so `WatchHeader` keeps its editor
   * open for a retry (same contract as `WatchCard.onRename`).
   */
  const onRenameTitle = useCallback(
    async (next: string | null): Promise<void> => {
      if (auth.kind !== "signed-in") return;
      if (!anchorWatch) {
        setName(next ?? "");
        return;
      }
      setNameSaving(true);
      try {
        const updated = await updateWatch(anchorWatch.id, { name: next });
        setAuth((prev) =>
          prev.kind === "signed-in"
            ? { ...prev, watches: new Map(prev.watches).set(anchorId, updated) }
            : prev,
        );
        setName(updated.name ?? "");
      } catch (err) {
        setSubmit({
          kind: "error",
          message: errorMessage(err, "Couldn't save that name."),
        });
        throw err;
      } finally {
        setNameSaving(false);
      }
    },
    [auth.kind, anchorWatch, anchorId],
  );

  /** Cancels the watch on the showtime currently being viewed. */
  const onCancelWatch = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || !viewedWatch) return;
    const target = viewing;
    setSubmit({ kind: "submitting" });
    try {
      await cancelWatch(viewedWatch.id);
      setAuth((prev) => {
        if (prev.kind !== "signed-in") return prev;
        const watches = new Map(prev.watches);
        watches.delete(target);
        return { ...prev, watches };
      });
      setSubmit({ kind: "idle" });
      if (target === anchorId) setNotifyAnySeat(false);
    } catch (err) {
      setSubmit({
        kind: "error",
        message: errorMessage(err, "Couldn't cancel that watch."),
      });
    }
  }, [auth.kind, viewedWatch, viewing, anchorId]);

  const isSignedIn = auth.kind === "signed-in";
  // "Watch all seats" is anchor-only and create-time-only: the flag can't be
  // PATCHed after creation, and fan-out carries one shared flag for the whole
  // batch rather than one per target. Grouped mode is a seat-picking mode, so
  // the choice isn't offered there either.
  const allowWatchAll =
    isSignedIn && !grouped && isAnchorView && anchorWatch === null;

  const viewedLoadError = loadErrors.get(viewing) ?? null;
  const errorIds = useMemo(() => new Set(loadErrors.keys()), [loadErrors]);

  // What the action panel is configuring: one time, or the whole ticked batch.
  const panelScope = grouped
    ? ticked.size > 0
      ? `${plural(ticked.size, "time")}`
      : "no times ticked"
    : hasSwitcher
      ? timeLabelFor(viewing)
      : null;

  return (
    <>
      {/* The header lives inside this client root (rather than in the server
          page) because the editable title is fed by the anchor's watch, which
          only exists here. Keeps it to one getMe/listWatches round-trip.
          It stays on the *anchor* even while another tab is being viewed —
          the pasted showtime is the page's identity. */}
      <WatchHeader
        data={initial}
        name={isSignedIn ? name || null : null}
        watchShowtimeAt={anchorWatch?.showtime_at ?? null}
        onRename={isSignedIn ? onRenameTitle : null}
        renaming={nameSaving}
      />

      <section className={pageStyles.mapCard} aria-label="Seat map">
        <ShowtimeSwitcher
          auditorium={siblings?.auditorium ?? null}
          dayLabel={formatDay(
            initial.showtime.showtime_local ?? siblings?.showtime_local ?? null,
          )}
          options={switcherOptions}
          mode={mode}
          onModeChange={onModeChange}
          viewing={viewing}
          onView={onView}
          ticked={ticked}
          onToggleTicked={onToggleTicked}
          loadingIds={loadingIds}
          errorIds={errorIds}
          notice={normalizeNotice}
        />

        {grouped ? (
          <SeatMap
            layout={baseLayout}
            statusMode="neutral"
            freeAt={freeAt}
            selectedIds={groupedSelected}
            watchedIds={groupedWatched}
            onSeatPaint={ticked.size > 0 ? onPaintSeat : undefined}
          />
        ) : viewed ? (
          <SeatMap
            layout={viewed.layout}
            selectedIds={viewedSelection}
            watchedIds={viewedWatchedIds}
            flashIds={flashIds}
            onSeatPaint={onPaintSeat}
          />
        ) : viewedLoadError ? (
          <div className={styles.mapNotice} role="alert">
            <span className={styles.mapNoticeTag}>Unavailable</span>
            <span>{viewedLoadError}</span>
          </div>
        ) : (
          <div className={styles.mapNotice}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>Loading the {timeLabelFor(viewing)} seat map…</span>
          </div>
        )}

        <ActionPanel
          auth={auth}
          grouped={grouped}
          tickedCount={ticked.size}
          viewedWatch={viewedWatch}
          panelScope={panelScope}
          allowWatchAll={allowWatchAll}
          watchAll={notifyAnySeat}
          onToggleWatchAll={onToggleWatchAll}
          watchedLabels={panelWatchedLabels}
          pendingLabels={panelPendingLabels}
          pendingCount={panelPendingLabels.length}
          onClearSelection={onClearSelection}
          totalPendingSeats={totalPendingSeats}
          showtimesWithPicks={showtimesWithPicks}
          canSubmit={canSubmit}
          submit={submit}
          onSubmit={onSubmit}
          onCancelWatch={onCancelWatch}
          timeLabelFor={timeLabelFor}
        />
      </section>
    </>
  );
}

// --- action panel sub-component ------------------------------------------

function ActionPanel({
  auth,
  grouped,
  tickedCount,
  viewedWatch,
  panelScope,
  allowWatchAll,
  watchAll,
  onToggleWatchAll,
  watchedLabels,
  pendingLabels,
  pendingCount,
  onClearSelection,
  totalPendingSeats,
  showtimesWithPicks,
  canSubmit,
  submit,
  onSubmit,
  onCancelWatch,
  timeLabelFor,
}: {
  auth: AuthState;
  grouped: boolean;
  tickedCount: number;
  viewedWatch: Watch | null;
  /** What's being configured — a single time, the ticked batch, or (null) the
   *  only showing this film has. */
  panelScope: string | null;
  allowWatchAll: boolean;
  watchAll: boolean;
  onToggleWatchAll: () => void;
  watchedLabels: string[];
  pendingLabels: string[];
  pendingCount: number;
  onClearSelection: () => void;
  totalPendingSeats: number;
  showtimesWithPicks: number;
  canSubmit: boolean;
  submit: SubmitState;
  onSubmit: () => void;
  onCancelWatch: () => void;
  timeLabelFor: (showtimeId: number) => string;
}): JSX.Element {
  // "Already watching" / cancel are per-showtime concepts; grouped mode is
  // configuring several at once, so it defers both to the per-showtime tab.
  const hasExisting = !grouped && viewedWatch !== null;
  const existingIsAll = !grouped && viewedWatch?.notify_any_seat === true;
  const existingIsSpecific = hasExisting && !existingIsAll;
  const isSignedIn = auth.kind === "signed-in";
  const isSubmitting = submit.kind === "submitting";
  const multi = showtimesWithPicks > 1;

  let ctaLabel: string;
  if (grouped && tickedCount === 0) {
    ctaLabel = "Tick a time first";
  } else if (grouped && pendingCount > 0) {
    ctaLabel = `Start watching ${pendingCount} × ${plural(tickedCount, "time")}`;
  } else if (multi) {
    ctaLabel = `Start watching ${totalPendingSeats} seats across ${showtimesWithPicks} showtimes`;
  } else if (existingIsAll) {
    ctaLabel = "Watching all seats";
  } else if (existingIsSpecific) {
    ctaLabel =
      totalPendingSeats > 0
        ? `Add ${plural(totalPendingSeats, "seat")}`
        : "Saved";
  } else if (watchAll && totalPendingSeats === 0) {
    ctaLabel = "Start watching all seats";
  } else if (totalPendingSeats > 0) {
    ctaLabel = `Start watching ${plural(totalPendingSeats, "seat")}`;
  } else {
    ctaLabel = allowWatchAll ? "Pick seats or watch all" : "Pick seats";
  }

  return (
    <section className={styles.panel} aria-label="Watch setup">
      <div className={styles.header}>
        <span className={styles.kicker}>
          {panelScope ? `Watch setup — ${panelScope}` : "Watch setup"}
        </span>
        {hasExisting ? (
          <span className={styles.statusFlag}>
            <span className={styles.flagDot} aria-hidden="true" />
            Already watching this showtime
          </span>
        ) : null}
      </div>

      <div className={styles.grid}>
        {/* LEFT — what to watch */}
        <div className={styles.selectionCol}>
          {grouped ? (
            <>
              {watchedLabels.length > 0 ? (
                <div className={styles.watchedBlock}>
                  <span className={styles.smallLabel}>
                    Already watching at every ticked time
                  </span>
                  <ul className={styles.chipList}>
                    {watchedLabels.map((label) => (
                      <li
                        className={`${styles.seatChip} ${styles.seatChipWatched}`}
                        key={`w-${label}`}
                      >
                        {label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <SelectionSummary
                count={pendingCount}
                labels={pendingLabels}
                onClear={onClearSelection}
              />
            </>
          ) : existingIsAll ? (
            <AllSeatsBox locked />
          ) : existingIsSpecific ? (
            <>
              {watchedLabels.length > 0 ? (
                <div className={styles.watchedBlock}>
                  <span className={styles.smallLabel}>Currently watching</span>
                  <ul className={styles.chipList}>
                    {watchedLabels.map((label) => (
                      <li
                        className={`${styles.seatChip} ${styles.seatChipWatched}`}
                        key={`w-${label}`}
                      >
                        {label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <SelectionSummary
                count={pendingCount}
                labels={pendingLabels}
                onClear={onClearSelection}
                addMode
              />
            </>
          ) : allowWatchAll ? (
            <>
              <button
                type="button"
                className={`${styles.watchAllBtn} ${watchAll ? styles.watchAllBtnActive : ""}`}
                onClick={onToggleWatchAll}
                aria-pressed={watchAll}
              >
                <span className={styles.watchAllMark} aria-hidden="true">
                  {watchAll ? "✓" : "+"}
                </span>
                <span className={styles.watchAllCopy}>
                  <span className={styles.watchAllTitle}>
                    {watchAll ? "Watching all seats" : "Watch all seats"}
                  </span>
                  <span className={styles.watchAllSub}>
                    Every seat in this auditorium — we alert you the moment any
                    one opens up.
                  </span>
                </span>
              </button>

              {!watchAll ? (
                <>
                  <div className={styles.orRule}>
                    <span>or pick specific seats</span>
                  </div>
                  <SelectionSummary
                    count={pendingCount}
                    labels={pendingLabels}
                    onClear={onClearSelection}
                  />
                </>
              ) : null}
            </>
          ) : (
            // A sibling tab, or a signed-out visitor previewing picks.
            <SelectionSummary
              count={pendingCount}
              labels={pendingLabels}
              onClear={onClearSelection}
            />
          )}

          {grouped && pendingCount > 0 ? (
            <p className={styles.spanNote}>
              {plural(pendingCount, "seat")} × {plural(tickedCount, "time")} ={" "}
              {totalPendingSeats} seat watches. One tap saves them all.
            </p>
          ) : !grouped && multi ? (
            <p className={styles.spanNote}>
              {totalPendingSeats} seats picked across {showtimesWithPicks}{" "}
              showtimes. One tap saves them all.
            </p>
          ) : null}
        </div>

        {/* RIGHT — commit */}
        <div className={styles.controlsCol}>
          {isSignedIn ? (
            <>
              <button
                type="button"
                className={styles.primary}
                onClick={onSubmit}
                disabled={!canSubmit}
                aria-busy={isSubmitting}
              >
                <span>{isSubmitting ? "Saving" : ctaLabel}</span>
                <span className={styles.arrow} aria-hidden="true">
                  {isSubmitting ? "…" : "→"}
                </span>
              </button>

              {submit.kind === "report" ? (
                <ResultsList
                  lines={submit.lines}
                  timeLabelFor={timeLabelFor}
                />
              ) : null}

              <div className={styles.commitFooter}>
                {submit.kind === "error" ? (
                  <span className={styles.statusError} role="alert">
                    {submit.message}
                  </span>
                ) : submit.kind === "ok" ? (
                  <span className={styles.statusOk} role="status">
                    {submit.watch.notify_any_seat
                      ? "Watching every seat."
                      : `Saved — ${plural(submit.watch.seats.length, "seat")} on watch.`}
                  </span>
                ) : submit.kind === "report" ? (
                  <span className={styles.statusIdle}>
                    Anything that didn&rsquo;t land keeps its picks — press the
                    button again to retry it.
                  </span>
                ) : (
                  <span className={styles.statusIdle}>
                    {hasExisting
                      ? "Live — we’ll alert you when a seat opens."
                      : "No password — alerts arrive by email."}
                  </span>
                )}
                {hasExisting ? (
                  <button
                    type="button"
                    className={styles.cancelLink}
                    onClick={onCancelWatch}
                    disabled={isSubmitting}
                  >
                    {panelScope
                      ? `Cancel ${panelScope} watch`
                      : "Cancel watch"}
                  </button>
                ) : null}
              </div>
            </>
          ) : auth.kind === "signed-out" ? (
            <SignedOutPrompt count={totalPendingSeats} watchAll={watchAll} />
          ) : (
            <div className={styles.loadingHint}>
              <span className={styles.spinner} aria-hidden="true" />
              Checking your session…
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Per-showtime outcome list (plan §4.3). Only rendered when a submit touched
 * more than one showtime — a single-showtime save keeps its one-line status.
 */
function ResultsList({
  lines,
  timeLabelFor,
}: {
  lines: ResultLine[];
  timeLabelFor: (showtimeId: number) => string;
}): JSX.Element {
  return (
    <ul className={styles.results} aria-label="Results by showtime">
      {lines.map((line) => (
        <li className={styles.resultRow} key={line.showtime_id}>
          <span
            className={`${styles.resultMark} ${line.ok ? styles.resultMarkOk : styles.resultMarkBad}`}
            aria-hidden="true"
          >
            {line.ok ? "✓" : "!"}
          </span>
          <span className={styles.resultTime}>
            {timeLabelFor(line.showtime_id)}
          </span>
          <span className={styles.resultBody}>
            <span className={line.ok ? styles.resultText : styles.resultTextBad}>
              {line.text}
            </span>
            {/* Falls out of the availability check the backend runs anyway: if a
                seat is open *right now*, saying so beats watching for it. */}
            {line.alreadyAvailable.length > 0 ? (
              <span className={styles.resultFree}>
                {line.alreadyAvailable.join(", ")}{" "}
                {line.alreadyAvailable.length === 1 ? "is" : "are"} free right
                now
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A single "All" summary box, shown when a watch covers every seat (rather
// than listing every seat label as a chip). `locked` reflects that an existing
// watch's mode can't be changed without cancelling.
function AllSeatsBox({ locked = false }: { locked?: boolean }): JSX.Element {
  return (
    <div className={styles.allBox}>
      <span className={styles.allBadge}>All</span>
      <span className={styles.allCopy}>
        <span className={styles.allTitle}>Every seat is watched</span>
        <span className={styles.allSub}>
          {locked
            ? "Tracking all seats in this showtime — cancel below to change."
            : "We’ll alert you the moment any seat in this auditorium opens."}
        </span>
      </span>
    </div>
  );
}

// The "pick specific seats" summary: a running count, the chosen seat chips,
// and a clear affordance. Shared by the create flow and the add-to-existing
// flow (`addMode` tweaks the label to "… to add").
function SelectionSummary({
  count,
  labels,
  onClear,
  addMode = false,
}: {
  count: number;
  labels: string[];
  onClear: () => void;
  addMode?: boolean;
}): JSX.Element {
  return (
    <div className={styles.selSummary}>
      <div className={styles.numeralBlock}>
        <span className={styles.numeral}>{count}</span>
        <span className={styles.numeralLabel}>
          {count === 1 ? "seat picked" : "seats picked"}
          {addMode && count > 0 ? " to add" : ""}
        </span>
      </div>
      {labels.length > 0 ? (
        <>
          <ul className={styles.chipList}>
            {labels.map((label) => (
              <li className={styles.seatChip} key={`s-${label}`}>
                {label}
              </li>
            ))}
          </ul>
          <button type="button" className={styles.clearLink} onClick={onClear}>
            Clear selection
          </button>
        </>
      ) : (
        <p className={styles.hint}>
          Click a seat to pick it — or click and drag across several at once.
          Occupied seats too; we ping you when a watched seat opens up.
        </p>
      )}
    </div>
  );
}

function SignedOutPrompt({
  count,
  watchAll,
}: {
  count: number;
  watchAll: boolean;
}): JSX.Element {
  const ready = count > 0 || watchAll;
  return (
    <div className={styles.signedOut}>
      <p className={styles.signedOutLede}>
        {ready
          ? "Sign in to save your picks — your selection sticks around while you do."
          : "Sign in by email to start watching seats. No password ever."}
      </p>
      <Link href="/#members" className={styles.signedOutCta}>
        <span>Sign in by email</span>
        <span className={styles.arrow} aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
