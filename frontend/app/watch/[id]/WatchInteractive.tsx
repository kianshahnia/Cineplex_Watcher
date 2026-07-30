"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  MAX_ADJACENT_SEATS,
  MAX_FANOUT_TARGETS,
  addSeatsToWatch,
  createWatch,
  deleteWatches,
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
import { buildBenches, maxPossibleBlock } from "@/lib/seatGroups";
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

/** How a saved alert threshold reads back in the results list. */
function describeThreshold(minAdjacent: number | null): string {
  return minAdjacent === null
    ? "Alerting on each seat"
    : `Alerting on ${minAdjacent} seats together`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WatchInteractive({ initial }: Props): JSX.Element {
  const { theatre_id, showtime_id: anchorId } = initial.showtime;

  // --- multi-showtime seat data ------------------------------------------
  // Lazily filled as the user ticks times. No batch endpoint: siblings share an
  // identical layout, so a `…/group` call is the obvious optimization if this
  // ever feels slow — a handful of calls against a 30/min-per-IP limit is
  // comfortable.
  const [seatData, setSeatData] = useState<Map<number, ShowtimeWithSeats>>(
    () => new Map([[anchorId, initial]]),
  );
  const [loadingIds, setLoadingIds] = useState<Set<number>>(() => new Set());
  const [loadErrors, setLoadErrors] = useState<Map<number, string>>(
    () => new Map(),
  );

  // --- what the picks apply to -------------------------------------------
  // The pasted showtime starts ticked and nothing else does, so a user who only
  // wants that one showing never has to touch the switcher. There is no second
  // mode: a seat click always lands on every ticked time, which with one ticked
  // is exactly the old single-showtime behaviour.
  const [ticked, setTicked] = useState<Set<number>>(() => new Set([anchorId]));
  const [tickNotice, setTickNotice] = useState<string | null>(null);

  // Refresh the anchor's entry if the server re-renders the page, without
  // dropping the siblings the user has already loaded.
  useEffect(() => {
    setSeatData((prev) => {
      const next = new Map(prev);
      next.set(initial.showtime.showtime_id, initial);
      return next;
    });
  }, [initial]);

  // One map stands in for every ticked showtime. Siblings share an identical
  // layout (that identity is the whole feature), and the anchor's is the one
  // guaranteed to be loaded, so it is the stand-in.
  const baseLayout = seatData.get(anchorId)?.layout ?? initial.layout;

  // --- sibling showtimes --------------------------------------------------
  const [siblings, setSiblings] = useState<SiblingShowtimes | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const set = await getShowtimeAlternatives(theatre_id, anchorId);
        if (!cancelled) setSiblings(set);
      } catch {
        // Metadata-class feature: degrade silently. No switcher is exactly what
        // a single-showing film renders, so there is nothing to report.
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

  // What needs seat data right now. Deliberately built from `ticked` only —
  // stable across a pick — so the fetch effect below never re-runs because a
  // seat was clicked.
  const wantedIds = useMemo<number[]>(() => [...ticked], [ticked]);

  // Fetch each showtime's seat data the first time it's needed. Every ticked
  // time is asked for at once and the markers fill in progressively.
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
  // Picks held while nothing is ticked. `selections` has to stay a subset of
  // `ticked` (otherwise submit would fan seats out to a showtime the user can't
  // see), so unticking the last time parks the shared set here instead of
  // dropping it. A ref rather than state: nothing renders from it, and it must
  // not trigger the persist effect. Not persisted — a reload resets to the
  // anchor ticked, which is a deliberately bigger reset than a tick.
  const stashedPicksRef = useRef<ReadonlySet<string>>(NO_SEATS);
  // The user's personal label for this watch, edited by clicking the page
  // title. Sent along with the create call; PATCHed in place afterwards.
  const [name, setName] = useState<string>("");
  const [nameSaving, setNameSaving] = useState<boolean>(false);
  // "Only alert me when this many of my seats are free side by side."
  // null = off, which is the original behaviour: alert on each seat as it opens.
  // Deliberately part of the submit rather than saved on change — one button
  // commits everything the panel is showing, and there is no blur/click race to
  // lose a keystroke to.
  const [minAdjacent, setMinAdjacent] = useState<number | null>(null);

  // hydrate from localStorage on mount
  useEffect(() => {
    const stored = loadWorkingSet(theatre_id, anchorId);
    if (stored.selections.size > 0) setSelections(stored.selections);
    if (stored.ticked.size > 0) setTicked(stored.ticked);
  }, [theatre_id, anchorId]);

  // persist on every change
  useEffect(() => {
    saveWorkingSet(theatre_id, anchorId, { selections, ticked });
  }, [selections, ticked, theatre_id, anchorId]);

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
      // Emptying is allowed here: nothing ticked is a valid state (a greyed-out,
      // read-only map), so a rescheduled set doesn't need a fallback tick.
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
        setName(anchorWatch.name ?? "");
        // Prefilled from the anchor only, matching `name`. Re-reading it on every
        // tick would make the field jump around as the user builds a batch, and
        // the batch is meant to end up sharing one threshold anyway.
        setMinAdjacent(anchorWatch.min_adjacent_seats ?? null);
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

  // --- the single-showtime shorthand -------------------------------------
  // With exactly one time in play the page is unambiguously *about* it, which
  // is what re-enables the per-showtime affordances: a live socket, the
  // "already watching" flag, cancel, and the watch-all toggle. With several,
  // all four would be ambiguous about which showtime they meant.
  const soleTicked = ticked.size === 1 ? ([...ticked][0] ?? null) : null;
  const soleData = soleTicked !== null ? seatData.get(soleTicked) : undefined;

  // Only one showtime can be watched live at a time, and only when it is the
  // only one in play — a flash on a map standing in for four showings would be
  // claiming a status the map deliberately isn't stating.
  useShowtimeEvents({
    showtimeUuid: soleData?.showtime.id ?? null,
    enabled:
      Boolean(soleData?.showtime.is_active) && !soleData?.is_post_showtime,
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
  /** The watch the panel is about — only meaningful with one time ticked. */
  const scopedWatch =
    auth.kind === "signed-in" && soleTicked !== null
      ? (auth.watches.get(soleTicked) ?? null)
      : null;

  const flashIds = useMemo<Set<string>>(() => {
    if (soleTicked === null) return NO_SEATS;
    const prefix = `${soleTicked}:`;
    const out = new Set<string>();
    for (const key of flashKeys) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
    }
    return out;
  }, [flashKeys, soleTicked]);

  // --- switcher options ---------------------------------------------------
  const switcherOptions = useMemo<SwitcherOption[]>(() => {
    const anchorOption: SwitcherOption = {
      showtime_id: anchorId,
      showtime_local:
        initial.showtime.showtime_local ?? siblings?.showtime_local ?? null,
      isAnchor: true,
      watching: anchorWatch !== null,
      isSoldOut: initial.is_sold_out,
    };
    const rest: SwitcherOption[] = (siblings?.alternatives ?? []).map((alt) => ({
      showtime_id: alt.showtime_id,
      showtime_local: alt.showtime_local,
      isAnchor: false,
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
  }, [anchorId, initial, siblings, anchorWatch, auth]);

  const timeLabelFor = useCallback(
    (showtimeId: number): string => {
      const opt = switcherOptions.find((o) => o.showtime_id === showtimeId);
      return formatTime(opt?.showtime_local ?? null) ?? `#${showtimeId}`;
    },
    [switcherOptions],
  );

  const hasSwitcher = switcherOptions.length > 1;

  // --- seat-map derived data ---------------------------------------------

  /** `ticked`, in the switcher's chronological order. */
  const tickedIds = useMemo<number[]>(
    () =>
      switcherOptions
        .filter((o) => ticked.has(o.showtime_id))
        .map((o) => o.showtime_id),
    [switcherOptions, ticked],
  );

  /** The shared set every ticked showtime holds. */
  const selectedSeats = useMemo<Set<string>>(
    () => unionPicks(selections, ticked),
    [selections, ticked],
  );

  /**
   * Locked seats = committed at **every** ticked showtime. One that's watched at
   * only some stays selectable, so the user can fill the gaps (plan §6.3). With
   * a single time ticked this is just that watch's seats.
   */
  const watchedSeats = useMemo<Set<string>>(() => {
    if (tickedIds.length === 0) return NO_SEATS;
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
  }, [tickedIds, watchedByShowtime]);

  /**
   * Seat id → the ticked times where it is already Available. The one status
   * fact that survives the neutral map, because it is true no matter which
   * showtime you have in mind — with one time ticked it degrades to plain "this
   * seat is free". Built only from showtimes already fetched, so the markers
   * appear progressively as the parallel fetches land.
   */
  const freeAt = useMemo<ReadonlyMap<string, string[]>>(() => {
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
    return out.size > 0 ? out : NO_FREE;
  }, [tickedIds, seatData, timeLabelFor]);

  // --- what the action panel shows ---------------------------------------

  const pendingSeats = useMemo<string[]>(
    () => [...selectedSeats].filter((id) => !watchedSeats.has(id)),
    [selectedSeats, watchedSeats],
  );

  // Labels are read off the anchor's layout: it is the one always loaded, and
  // siblings share seat keys by construction (that identity is the feature).
  const panelPendingLabels = useMemo<string[]>(
    () => sortLabels(pendingSeats.map((id) => labelFor(anchorId, id))),
    [pendingSeats, anchorId, labelFor],
  );

  const panelWatchedLabels = useMemo<string[]>(
    () => sortLabels([...watchedSeats].map((id) => labelFor(anchorId, id))),
    [watchedSeats, labelFor, anchorId],
  );

  /**
   * Ticked showtimes the user already watches — everything a Cancel acts on.
   *
   * Cancel used to be scoped to `scopedWatch`, i.e. offered only with a single
   * time in play, which meant untangling a four-showtime fan-out took four
   * visits to the switcher. Ticked *is* the page's scope for every other
   * gesture (a seat pick lands on all of them), so it is the scope here too.
   * Kept in the switcher's chronological order, so the button's label and any
   * failure list read in the same order as the chips.
   */
  const cancelTargets = useMemo<number[]>(() => {
    if (auth.kind !== "signed-in") return [];
    const { watches } = auth;
    return tickedIds.filter((id) => watches.has(id));
  }, [auth, tickedIds]);

  // --- adjacent-seat threshold -------------------------------------------

  /** Physical adjacency of the room. Siblings share a layout, so the anchor's
   *  stands in for all of them — same assumption the map itself makes. */
  const benches = useMemo<string[][]>(
    () => buildBenches(baseLayout.rows),
    [baseLayout],
  );

  /** Every seat that will be on the watch: picked now plus already committed. */
  const blockPicks = useMemo<Set<string>>(() => {
    const out = new Set(selectedSeats);
    for (const seatId of watchedSeats) out.add(seatId);
    return out;
  }, [selectedSeats, watchedSeats]);

  /**
   * The biggest block these picks could ever yield, if every seat between them
   * went free. A threshold above it describes a watch that would sit until the
   * screening starts and never say a word, which is what the CTA refuses to save.
   */
  const blockCeiling = useMemo<number>(
    () => maxPossibleBlock(benches, blockPicks),
    [benches, blockPicks],
  );
  const blockImpossible = minAdjacent !== null && minAdjacent > blockCeiling;

  // --- work summary -------------------------------------------------------
  const totalPendingSeats = useMemo<number>(() => {
    let total = 0;
    for (const pending of pendingByShowtime.values()) total += pending.length;
    return total;
  }, [pendingByShowtime]);

  /**
   * Ticked showtimes already watched whose stored threshold differs from the
   * field. These are what makes a threshold-only save possible: without them,
   * changing 4 to 2 on an existing watch with no new seats to add would leave the
   * CTA disabled and the change unsavable.
   */
  const thresholdTargets = useMemo<number[]>(() => {
    if (auth.kind !== "signed-in") return [];
    const { watches } = auth;
    return tickedIds.filter((id) => {
      const watch = watches.get(id);
      return (
        watch != null && (watch.min_adjacent_seats ?? null) !== minAdjacent
      );
    });
  }, [auth, tickedIds, minAdjacent]);

  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  // Cancelling is tracked apart from `submit` so the primary CTA doesn't read
  // "Saving" while watches are being torn down — a distinction that barely
  // registered when cancel meant one request and matters when it means eight.
  const [cancelling, setCancelling] = useState<boolean>(false);

  const canSubmit =
    auth.kind === "signed-in" &&
    submit.kind !== "submitting" &&
    !cancelling &&
    // Nothing ticked = nothing to save to, whatever else is set.
    ticked.size > 0 &&
    // A threshold the picks can never satisfy would create a silent watch.
    !blockImpossible &&
    (totalPendingSeats > 0 || thresholdTargets.length > 0);

  // --- interaction --------------------------------------------------------

  const clearSubmitNotice = useCallback((): void => {
    setSubmit((s) =>
      s.kind !== "idle" && s.kind !== "submitting" ? { kind: "idle" } : s,
    );
  }, []);

  const scopedIsAll = scopedWatch?.notify_any_seat === true;

  /**
   * Set a batch of seats to the same picked state, on every ticked showtime at
   * once — with one ticked that is exactly the old single-showtime behaviour,
   * with several it is the whole point.
   *
   * Batched rather than one-seat-at-a-time so a row-letter click lands in a
   * single state update instead of one per seat in the row.
   */
  const paintSeats = useCallback(
    (seatIds: string[], select: boolean): void => {
      if (ticked.size === 0 || seatIds.length === 0) return;
      // A pre-existing "watch all seats" watch (the flag is no longer settable,
      // but old watches still carry it) covers every seat already, so picking
      // individual ones is a no-op rather than a contradiction.
      if (scopedIsAll) return;

      setSelections((prev) => {
        const out = new Map(prev);
        let changed = false;
        for (const id of ticked) {
          const watched = watchedByShowtime.get(id) ?? NO_SEATS;
          const current = out.get(id) ?? NO_SEATS;
          const next = new Set(current);
          let touched = false;
          for (const seatId of seatIds) {
            // Already committed here — nothing to add, and nothing a deselect
            // could take away (per-seat delete needs a backend endpoint).
            if (watched.has(seatId)) continue;
            if (next.has(seatId) === select) continue;
            if (select) {
              next.add(seatId);
            } else {
              next.delete(seatId);
            }
            touched = true;
          }
          if (!touched) continue;
          changed = true;
          if (next.size === 0) {
            out.delete(id);
          } else {
            out.set(id, next);
          }
        }
        return changed ? out : prev;
      });
      setTickNotice(null);
      clearSubmitNotice();
    },
    [ticked, scopedIsAll, watchedByShowtime, clearSubmitNotice],
  );

  // One seat. `select` is decided by the SeatMap: a click toggles, a drag paints
  // every crossed seat to the same value.
  const onPaintSeat = useCallback(
    (seatId: string, select: boolean): void => {
      paintSeats([seatId], select);
    },
    [paintSeats],
  );

  const onMinAdjacentChange = useCallback(
    (next: number | null): void => {
      setMinAdjacent(next);
      // The old result list described a threshold that is no longer the one in
      // the field, so it stops being true the moment this changes.
      clearSubmitNotice();
    },
    [clearSubmitNotice],
  );

  const onClearSelection = useCallback((): void => {
    setSelections((prev) => {
      if (![...ticked].some((id) => prev.has(id))) return prev;
      const out = new Map(prev);
      for (const id of ticked) out.delete(id);
      return out;
    });
    setTickNotice(null);
    clearSubmitNotice();
  }, [ticked, clearSubmitNotice]);

  /**
   * Add or remove a showtime, keeping the invariant that every ticked showtime
   * holds exactly the shared set.
   *
   * Unticking therefore drops that time's picks — that is what a tick box means,
   * and it keeps the CTA's count honest. Ticking makes the new time inherit the
   * shared set, so "watch these seats at the 7 PM too" is one click.
   *
   * **Unticking the last time is allowed** and puts the page into a greyed-out,
   * read-only state. Because the invariant is "selections keys ⊆ ticked" — which
   * is what keeps submit from fanning picks out to a showtime the user can't see
   * — the picks can't just stay in the map. They're stashed instead, and handed
   * back the moment a time is ticked again, so unticking everything reads as a
   * pause rather than a Clear.
   */
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
      // only showtime that happened to carry the picks doesn't erase them for
      // the rest. Coming back from empty there is no previous set to read, so
      // the stash stands in.
      const wasEmpty = ticked.size === 0;
      const shared = wasEmpty
        ? stashedPicksRef.current
        : unionPicks(selections, ticked);

      let notice: string | null = null;
      if (next.size === 0) {
        stashedPicksRef.current = shared;
        setSelections(new Map());
        if (shared.size > 0) {
          notice = `${plural(shared.size, "pick")} held — tick a time to bring ${
            shared.size === 1 ? "it" : "them"
          } back.`;
        }
      } else {
        stashedPicksRef.current = NO_SEATS;
        setSelections(groupedSelections(next, shared));
        if (shared.size === 0) {
          notice = null;
        } else if (wasEmpty) {
          // Closes the loop on the "held" message above. The seats lighting back
          // up says it too, but only if you happen to be looking at the map.
          notice = `${plural(shared.size, "pick")} restored.`;
        } else if (next.size > ticked.size) {
          // Only reachable at 2+ ticked, so "all N times" is never "all 1 time".
          notice = `Your ${plural(shared.size, "pick")} now applies to all ${plural(next.size, "time")}.`;
        }
      }
      setTickNotice(notice);
      clearSubmitNotice();
    },
    [ticked, selections, clearSubmitNotice],
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

    // --- alert threshold on watches that already exist -------------------
    // A brand-new watch gets the threshold from `createWatch`, and a fan-out
    // target gets it from the fan-out call. What is left is showtimes the user
    // already watches and is not fanning to — including the anchor, whose
    // create-path is skipped when its watch exists. Those need a PATCH, or the
    // field would silently not apply to the very watches it was prefilled from.
    const fanoutIds = new Set(targets.map((t) => t.showtime_id));
    const patchIds = thresholdTargets.filter((id) => !fanoutIds.has(id));
    const rethreshold = new Map<number, Watch>();
    for (const showtimeId of patchIds) {
      const existing = auth.watches.get(showtimeId);
      if (!existing) continue;
      // A showtime that also has seats to save reports through its own line
      // below; a duplicate line saying only "threshold updated" would be noise.
      const alsoHasSeats = (pendingByShowtime.get(showtimeId)?.length ?? 0) > 0;
      try {
        rethreshold.set(
          showtimeId,
          await updateWatch(existing.id, { min_adjacent_seats: minAdjacent }),
        );
        if (!alsoHasSeats) {
          lines.push({
            showtime_id: showtimeId,
            ok: true,
            text: describeThreshold(minAdjacent),
            alreadyAvailable: [],
          });
        }
      } catch (err) {
        // Reported whether or not seats are also being saved: a failure here
        // means the alert rule is not what the panel claims.
        lines.push({
          showtime_id: showtimeId,
          ok: false,
          text: errorMessage(err, "Couldn't save the alert setting."),
          alreadyAvailable: [],
        });
      }
    }
    if (rethreshold.size > 0) {
      setAuth((prev) => {
        if (prev.kind !== "signed-in") return prev;
        const next = new Map(prev.watches);
        for (const [showtimeId, watch] of rethreshold) next.set(showtimeId, watch);
        return { ...prev, watches: next };
      });
    }

    // --- anchor ----------------------------------------------------------
    if (anchorPending.length > 0) {
      try {
        let watch = anchorWatch;
        if (!watch) {
          watch = await createWatch({
            theatre_id,
            showtime_id: anchorId,
            // Always specific seats now: "watch any seat" was a create-time
            // flag with no representation on the map, replaced by Select all
            // (bugs.md #12). Watches created before that still carry it and are
            // still honoured — nothing sets it any more.
            notify_any_seat: false,
            name: trimmedName,
            min_adjacent_seats: minAdjacent,
          });
        }
        watch = await addSeatsToWatch(
          watch.id,
          anchorPending.map((seatId) => ({
            seat_key: seatId,
            seat_label: labelFor(anchorId, seatId),
          })),
        );
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
          min_adjacent_seats: minAdjacent,
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
      setTickNotice(null);
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
    minAdjacent,
    thresholdTargets,
    pendingByShowtime,
    anchorId,
    anchorWatch,
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

  /**
   * Cancel the watch on every ticked showtime, in one gesture.
   *
   * One request, one transaction: `deleteWatches` takes the whole id list, so
   * there is no partial-success state to explain and no per-target retry to
   * offer — it either all went, or nothing did and the panel says so.
   *
   * Cancelling is a **permanent delete**, not a soft archive: the watch, its
   * seats and its history are gone. That is deliberate (bugs.md #8) — one
   * destructive action rather than two that were easy to confuse.
   */
  const onCancelWatches = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || cancelling || cancelTargets.length === 0) {
      return;
    }
    const { watches } = auth;
    const targets = cancelTargets.flatMap((showtimeId) => {
      const watch = watches.get(showtimeId);
      return watch ? [{ showtimeId, watchId: watch.id }] : [];
    });
    if (targets.length === 0) return;

    setCancelling(true);
    setSubmit({ kind: "idle" });
    try {
      // `missing` ids are already gone, so both halves of the response mean
      // the same thing here: stop showing them.
      await deleteWatches(targets.map((t) => t.watchId));
      setAuth((prev) => {
        if (prev.kind !== "signed-in") return prev;
        const next = new Map(prev.watches);
        for (const t of targets) next.delete(t.showtimeId);
        return { ...prev, watches: next };
      });
      // No closing word needed on success — the "already watching" flag and
      // the seat chips disappearing is the confirmation.
    } catch (err) {
      setSubmit({
        kind: "error",
        message: errorMessage(
          err,
          targets.length === 1
            ? "Couldn't cancel that watch."
            : "Couldn't cancel those watches. Nothing was changed.",
        ),
      });
    } finally {
      setCancelling(false);
    }
  }, [auth, cancelling, cancelTargets]);

  const isSignedIn = auth.kind === "signed-in";

  const errorIds = useMemo(() => new Set(loadErrors.keys()), [loadErrors]);

  // Ticked showtimes whose availability hasn't landed yet. Worth saying out
  // loud: until it does the map shows no free markers, which would otherwise
  // read as "every seat is taken".
  const pendingLoads = useMemo<number[]>(
    () => tickedIds.filter((id) => !seatData.has(id)),
    [tickedIds, seatData],
  );
  const failedLoads = useMemo<number[]>(
    () => tickedIds.filter((id) => loadErrors.has(id)),
    [tickedIds, loadErrors],
  );

  // What the action panel is configuring: one time, the whole ticked batch, or
  // (nothing ticked) no showtime at all.
  const panelScope =
    ticked.size === 0
      ? null
      : soleTicked !== null
        ? hasSwitcher
          ? timeLabelFor(soleTicked)
          : null
        : plural(ticked.size, "time");

  return (
    <>
      {/* The header lives inside this client root (rather than in the server
          page) because the editable title is fed by the anchor's watch, which
          only exists here. Keeps it to one getMe/listWatches round-trip.
          It stays on the *anchor* whatever is ticked — the pasted showtime is
          the page's identity. */}
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
          ticked={ticked}
          onToggleTicked={onToggleTicked}
          loadingIds={loadingIds}
          errorIds={errorIds}
          notice={tickNotice}
        />

        {/* The map itself always renders — the anchor's layout arrives with the
            server render, so there is never a blank card. What can lag is a
            newly-ticked sibling's *availability*, which is what these say. */}
        {failedLoads.length > 0 ? (
          <div className={styles.mapNotice} role="alert">
            <span className={styles.mapNoticeTag}>Unavailable</span>
            <span>
              Couldn&rsquo;t load availability for{" "}
              {failedLoads.map(timeLabelFor).join(", ")}. Seats there aren&rsquo;t
              marked free — untick and re-tick to retry.
            </span>
          </div>
        ) : pendingLoads.length > 0 ? (
          <div className={styles.mapNotice}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>
              Loading availability for {pendingLoads.map(timeLabelFor).join(", ")}
              …
            </span>
          </div>
        ) : null}

        <SeatMap
          layout={baseLayout}
          statusMode="neutral"
          freeAt={freeAt}
          multiTimes={ticked.size > 1}
          dimmed={ticked.size === 0}
          selectedIds={selectedSeats}
          watchedIds={watchedSeats}
          flashIds={flashIds}
          onSeatPaint={onPaintSeat}
          onBatchPaint={paintSeats}
        />

        <ActionPanel
          auth={auth}
          tickedCount={ticked.size}
          scopedWatch={scopedWatch}
          panelScope={panelScope}
          watchedLabels={panelWatchedLabels}
          pendingLabels={panelPendingLabels}
          pendingCount={panelPendingLabels.length}
          onClearSelection={onClearSelection}
          totalPendingSeats={totalPendingSeats}
          canSubmit={canSubmit}
          submit={submit}
          onSubmit={onSubmit}
          cancelTargets={cancelTargets}
          cancelling={cancelling}
          onCancelWatches={onCancelWatches}
          timeLabelFor={timeLabelFor}
          blockCeiling={blockCeiling}
          blockImpossible={blockImpossible}
          minAdjacent={minAdjacent}
          onMinAdjacentChange={onMinAdjacentChange}
        />
      </section>
    </>
  );
}

// --- action panel sub-component ------------------------------------------

function ActionPanel({
  auth,
  tickedCount,
  scopedWatch,
  panelScope,
  watchedLabels,
  pendingLabels,
  pendingCount,
  onClearSelection,
  totalPendingSeats,
  canSubmit,
  submit,
  onSubmit,
  cancelTargets,
  cancelling,
  onCancelWatches,
  timeLabelFor,
  blockCeiling,
  blockImpossible,
  minAdjacent,
  onMinAdjacentChange,
}: {
  auth: AuthState;
  tickedCount: number;
  /** The existing watch on the single ticked showtime — null with several
   *  ticked, where "which watch?" has no answer. */
  scopedWatch: Watch | null;
  /** What's being configured — a single time, the ticked batch, or (null) the
   *  only showing this film has. */
  panelScope: string | null;
  watchedLabels: string[];
  pendingLabels: string[];
  pendingCount: number;
  onClearSelection: () => void;
  totalPendingSeats: number;
  canSubmit: boolean;
  submit: SubmitState;
  onSubmit: () => void;
  /** Ticked showtimes that already have a watch — what Cancel acts on, in
   *  chronological order. */
  cancelTargets: number[];
  cancelling: boolean;
  onCancelWatches: () => void;
  timeLabelFor: (showtimeId: number) => string;
  /** Biggest block the current picks could ever produce. */
  blockCeiling: number;
  /** True when the threshold is above that, i.e. it could never fire. */
  blockImpossible: boolean;
  minAdjacent: number | null;
  onMinAdjacentChange: (next: number | null) => void;
}): JSX.Element {
  // The *seat* affordances stay per-showtime: with several times ticked there
  // is no single watch whose mode ("all seats" vs specific) the panel could be
  // describing. Cancel is different — it needs no single subject, so it acts on
  // every ticked watch at once.
  const single = tickedCount === 1;
  // Nothing ticked: the map above is greyed out and there is no showtime any of
  // this could be about, so the panel says only what to do next.
  const none = tickedCount === 0;
  const hasExisting = single && scopedWatch !== null;
  const existingIsAll = single && scopedWatch?.notify_any_seat === true;
  const existingIsSpecific = hasExisting && !existingIsAll;
  const isSignedIn = auth.kind === "signed-in";
  const isSubmitting = submit.kind === "submitting";

  // --- cancel scope -------------------------------------------------------
  const anyExisting = cancelTargets.length > 0;
  const soleCancelId = cancelTargets.length === 1 ? cancelTargets[0] : undefined;
  let cancelLabel = "Cancel watch";
  if (cancelTargets.length > 1) {
    cancelLabel = `Cancel ${cancelTargets.length} watches`;
  } else if (soleCancelId !== undefined) {
    // With one time in play the panel kicker already names it, so reuse that
    // wording (and its "no switcher ⇒ no time to name" null). With several
    // ticked but only one watched, the button has to say which one it means.
    const scope = single ? panelScope : timeLabelFor(soleCancelId);
    if (scope) cancelLabel = `Cancel ${scope} watch`;
  }

  let ctaLabel: string;
  if (none) {
    ctaLabel = "Select a showtime";
  } else if (blockImpossible) {
    // Says how to fix it, not just that it's broken. Checked before every other
    // branch because nothing else the button could offer is savable.
    ctaLabel =
      blockCeiling >= 2
        ? `Longest block is ${blockCeiling} — lower to ${blockCeiling}`
        : "Pick seats next to each other";
  } else if (!single && pendingCount > 0) {
    ctaLabel = `Start watching ${pendingCount} × ${plural(tickedCount, "time")}`;
  } else if (existingIsAll) {
    ctaLabel = "Watching all seats";
  } else if (existingIsSpecific) {
    ctaLabel =
      totalPendingSeats > 0
        ? `Add ${plural(totalPendingSeats, "seat")}`
        : "Saved";
  } else if (totalPendingSeats > 0) {
    ctaLabel = `Start watching ${plural(totalPendingSeats, "seat")}`;
  } else {
    ctaLabel = "Pick seats";
  }

  return (
    <section className={styles.panel} aria-label="Watch setup">
      <div className={styles.header}>
        <span className={styles.kicker}>
          {panelScope ? `Watch setup — ${panelScope}` : "Watch setup"}
        </span>
        {anyExisting ? (
          <span className={styles.statusFlag}>
            <span className={styles.flagDot} aria-hidden="true" />
            {single
              ? "Already watching this showtime"
              : `Already watching ${cancelTargets.length} of ${tickedCount} times`}
          </span>
        ) : null}
      </div>

      <div className={styles.grid}>
        {/* LEFT — what to watch */}
        <div className={styles.selectionCol}>
          {none ? (
            <NoShowtimeBox />
          ) : existingIsAll ? (
            <AllSeatsBox />
          ) : (
            <>
              {watchedLabels.length > 0 ? (
                <div className={styles.watchedBlock}>
                  <span className={styles.smallLabel}>
                    {single
                      ? "Currently watching"
                      : "Already watching at every ticked time"}
                  </span>
                  <SeatChips labels={watchedLabels} keyPrefix="w" watched />
                </div>
              ) : null}
              <SelectionSummary
                count={pendingCount}
                labels={pendingLabels}
                onClear={onClearSelection}
                addMode={existingIsSpecific}
                watchedCount={watchedLabels.length}
              />
            </>
          )}

          {!single && !none && pendingCount > 0 ? (
            <p className={styles.spanNote}>
              {plural(pendingCount, "seat")} × {plural(tickedCount, "time")} ={" "}
              {totalPendingSeats} seat watches. One tap saves them all.
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

              {/* Sits under the CTA because it qualifies what the CTA will do.
                  Hidden with nothing ticked (there is no watch for it to be
                  about) and on a legacy "watch all seats" watch, where the
                  poller ignores the threshold — an every-seat watch has no fixed
                  selection for blocks to form in. */}
              {!none && !existingIsAll ? (
                <AdjacentSeatField
                  value={minAdjacent}
                  onChange={onMinAdjacentChange}
                  ceiling={blockCeiling}
                  impossible={blockImpossible}
                  disabled={isSubmitting || cancelling}
                />
              ) : null}

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
                    {none
                      ? "Nothing selected — tick a time above."
                      : anyExisting
                        ? "Live — we’ll alert you when a seat opens."
                        : "No password — alerts arrive by email."}
                  </span>
                )}
                {anyExisting ? (
                  <button
                    type="button"
                    className={styles.cancelLink}
                    onClick={onCancelWatches}
                    disabled={isSubmitting || cancelling}
                    aria-busy={cancelling}
                    title={
                      cancelTargets.length > 1
                        ? `${cancelTargets.map(timeLabelFor).join(", ")} — removed permanently`
                        : "Removed permanently"
                    }
                  >
                    {cancelling ? "Cancelling…" : cancelLabel}
                  </button>
                ) : null}
              </div>
            </>
          ) : auth.kind === "signed-out" ? (
            <SignedOutPrompt count={totalPendingSeats} />
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

/**
 * Nothing is ticked. Occupies the slot the selection summary would, so the panel
 * keeps its shape, and says the one thing there is to say — the map above is
 * greyed out and this is why.
 */
function NoShowtimeBox(): JSX.Element {
  return (
    <div className={styles.emptyBox}>
      <span className={styles.emptyTitle}>No showtime selected</span>
      <span className={styles.emptySub}>
        Tick a time above to start picking seats. Nothing is lost — any picks you
        had are held until you do.
      </span>
    </div>
  );
}

/**
 * A seat-label chip list, capped.
 *
 * Select all makes a whole-auditorium pick one click, so these lists went from
 * "a handful of seats" to "258 of them" — a wall of chips that buries the
 * count, the Clear link and the CTA below it. Past the cap the rest collapse
 * into one `+N` chip whose tooltip spells them out, the same convention the
 * dashboard card uses. `sortLabels` has already put them in human order, so the
 * ones shown are the front of the room rather than an arbitrary slice.
 */
const MAX_VISIBLE_CHIPS = 24;

function SeatChips({
  labels,
  keyPrefix,
  watched = false,
}: {
  labels: string[];
  keyPrefix: string;
  watched?: boolean;
}): JSX.Element {
  const shown = labels.slice(0, MAX_VISIBLE_CHIPS);
  const rest = labels.slice(MAX_VISIBLE_CHIPS);
  const chipClass = watched
    ? `${styles.seatChip} ${styles.seatChipWatched}`
    : styles.seatChip;

  return (
    <ul className={styles.chipList}>
      {shown.map((label) => (
        <li className={chipClass} key={`${keyPrefix}-${label}`}>
          {label}
        </li>
      ))}
      {rest.length > 0 ? (
        <li
          className={`${styles.seatChip} ${styles.seatChipMore}`}
          title={rest.join(", ")}
        >
          +{rest.length}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Shown for a watch carrying the legacy `notify_any_seat` flag, instead of
 * listing every seat label as a chip.
 *
 * Nothing can create one of these any more — "Watch all seats" was replaced by
 * Select all (bugs.md #12), which paints real picks. Watches made before that
 * still hold the flag, are still honoured by the poller, and still need
 * describing here; the mode can't be edited, so cancelling is the only way out.
 */
function AllSeatsBox(): JSX.Element {
  return (
    <div className={styles.allBox}>
      <span className={styles.allBadge}>All</span>
      <span className={styles.allCopy}>
        <span className={styles.allTitle}>Every seat is watched</span>
        <span className={styles.allSub}>
          Tracking all seats in this showtime — cancel below to change.
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
  watchedCount = 0,
}: {
  count: number;
  labels: string[];
  onClear: () => void;
  addMode?: boolean;
  /** Seats already committed in whatever this panel is scoped to. Only used to
   *  keep the headline figure honest when there is nothing pending. */
  watchedCount?: number;
}): JSX.Element {
  // The numeral is the panel's focal figure, so it has to state something true.
  // Straight after a save there are no pending picks, and printing "0 seats
  // picked" under a list of freshly-saved seats reads as "nothing happened" —
  // the exact opposite of what just occurred. When there is nothing to commit
  // but seats *are* on watch, the figure reports those instead. A genuinely
  // empty panel (nothing picked, nothing watched) still shows 0: there it's the
  // invitation to start, not a report on work already done.
  const showingWatched = count === 0 && watchedCount > 0;
  const figure = showingWatched ? watchedCount : count;
  const noun = figure === 1 ? "seat" : "seats";

  return (
    <div className={styles.selSummary}>
      <div className={styles.numeralBlock}>
        <span className={styles.numeral}>{figure}</span>
        <span className={styles.numeralLabel}>
          {showingWatched
            ? `${noun} on watch`
            : `${noun} picked${addMode && count > 0 ? " to add" : ""}`}
        </span>
      </div>
      {labels.length > 0 ? (
        <>
          <SeatChips labels={labels} keyPrefix="s" />
          <button type="button" className={styles.clearLink} onClick={onClear}>
            Clear selection
          </button>
        </>
      ) : (
        <p className={styles.hint}>
          {showingWatched
            ? "Click another seat to add it to this watch — drag across several, or click a row letter to take the whole row."
            : "Click a seat to pick it — drag across several, or click a row letter to take the whole row. Occupied seats too; we ping you when a watched seat opens up."}
        </p>
      )}
    </div>
  );
}

/**
 * "Notify only when [N] seats open in a row" — the whole feature's one control.
 *
 * A plain number rather than a toggle plus a number: 1 already means "tell me
 * about every seat", so an on/off switch would be a second spelling of a state
 * the value can express, and the codebase has been bitten by exactly that before
 * (`min_adjacent_seats` is normalised server-side for the same reason).
 *
 * The field never blocks typing. It reports what the current picks could
 * actually deliver and lets the CTA — which is the thing that would create a
 * silent watch — be the one that refuses.
 */
function AdjacentSeatField({
  value,
  onChange,
  ceiling,
  impossible,
  disabled,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  /** Biggest block the current picks could ever produce. */
  ceiling: number;
  impossible: boolean;
  disabled: boolean;
}): JSX.Element {
  const commit = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      onChange(null);
      return;
    }
    // Below 2 is "off", not an error — and the server normalises it the same way.
    if (parsed < 2) {
      onChange(null);
      return;
    }
    onChange(Math.min(parsed, MAX_ADJACENT_SEATS));
  };

  return (
    <div className={styles.blockField}>
      <div className={styles.blockRow}>
        <label className={styles.blockLabel} htmlFor="min-adjacent-seats">
          Notify only when at least
        </label>
        <input
          id="min-adjacent-seats"
          className={`${styles.blockInput} ${impossible ? styles.blockInputBad : ""}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ADJACENT_SEATS}
          step={1}
          value={value ?? 1}
          disabled={disabled}
          aria-invalid={impossible}
          aria-describedby="min-adjacent-hint"
          onChange={(e) => commit(e.target.value)}
        />
        <span className={styles.blockLabel}>
          {value === 1 ? "seat opens" : "seats open in a row"}
        </span>
      </div>
      <p
        id="min-adjacent-hint"
        className={impossible ? styles.blockWarn : styles.blockHint}
        role={impossible ? "alert" : undefined}
      >
        {value === null ? (
          <>Set to 2 or more to hear only about seats that open side by side.</>
        ) : impossible ? (
          ceiling >= 2 ? (
            <>
              Your picks could only ever make a block of {ceiling}, so {value}{" "}
              would never alert you. Pick more adjacent seats, or{" "}
              <button
                type="button"
                className={styles.blockFix}
                onClick={() => onChange(ceiling)}
              >
                use {ceiling}
              </button>
              .
            </>
          ) : (
            <>
              Pick at least two seats next to each other — a block needs
              neighbours, and nothing in your selection touches.
            </>
          )
        ) : (
          <>
            Silent until {value} of your seats are free side by side. Your picks
            could make a block of up to {ceiling}.
          </>
        )}
      </p>
    </div>
  );
}

function SignedOutPrompt({ count }: { count: number }): JSX.Element {
  const ready = count > 0;
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
