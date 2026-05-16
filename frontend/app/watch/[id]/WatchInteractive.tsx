"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  addSeatsToWatch,
  cancelWatch,
  createWatch,
  getMe,
  listWatches,
} from "@/lib/api";
import type {
  CurrentUser,
  SeatDetail,
  SeatMapLayout,
  ShowtimeWithSeats,
  Watch,
} from "@/lib/api";
import { LiveSeatTicker } from "../../components/LiveSeatTicker";
import type { TickerItem } from "../../components/LiveSeatTicker";
import { LiveStatusPill } from "../../components/LiveStatusPill";
import { SeatMap } from "../../components/SeatMap";
import {
  useShowtimeEvents,
  type ShowtimeEvent,
  type WsStatus,
} from "@/hooks/useShowtimeEvents";
// TEST FIXTURE — used to detect the test showtime and run a fake event emitter
// instead of opening a real WebSocket. Safe to remove with the test/ folder.
import { isTestShowtimeUuid } from "@/lib/test/buildLayout";
import styles from "./WatchInteractive.module.css";

const STORAGE_PREFIX = "cinewatcher.selection.";

type AuthState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; user: CurrentUser; existingWatch: Watch | null };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; watch: Watch }
  | { kind: "error"; message: string };

interface Props {
  initial: ShowtimeWithSeats;
}

function storageKey(t: number, s: number): string {
  return `${STORAGE_PREFIX}${t}.${s}`;
}

function loadStoredSelection(t: number, s: number): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(storageKey(t, s));
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(
      arr.filter((x): x is string => typeof x === "string"),
    );
  } catch {
    return new Set();
  }
}

function saveStoredSelection(
  t: number,
  s: number,
  ids: Set<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(storageKey(t, s));
    } else {
      window.localStorage.setItem(storageKey(t, s), JSON.stringify([...ids]));
    }
  } catch {
    // ignore quota / privacy-mode errors
  }
}

const FLASH_DURATION_MS = 2400;
const TICKER_TTL_MS = 30_000;
const TICKER_MAX = 4;

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
  return changed ? { layout: { ...layout, rows }, changed: true } : { layout, changed: false };
}

export function WatchInteractive({ initial }: Props): JSX.Element {
  const { showtime } = initial;
  const { theatre_id, showtime_id } = showtime;

  // --- live seat layout (mutated by WS events) --------------------------
  const [layout, setLayout] = useState<SeatMapLayout>(initial.layout);

  // Reset layout if the initial prop ever changes (e.g. RSC re-fetch).
  useEffect(() => {
    setLayout(initial.layout);
  }, [initial.layout]);

  // --- selection ---------------------------------------------------------
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [notifyAnySeat, setNotifyAnySeat] = useState<boolean>(false);

  // hydrate from localStorage on mount
  useEffect(() => {
    const stored = loadStoredSelection(theatre_id, showtime_id);
    if (stored.size > 0) {
      setSelectedIds(stored);
    }
  }, [theatre_id, showtime_id]);

  // persist on every change
  useEffect(() => {
    saveStoredSelection(theatre_id, showtime_id, selectedIds);
  }, [selectedIds, theatre_id, showtime_id]);

  // --- auth + existing watch -------------------------------------------
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const refreshAuth = useCallback(async () => {
    setAuth({ kind: "loading" });
    try {
      const user = await getMe();
      if (!user) {
        setAuth({ kind: "signed-out" });
        return;
      }
      let existingWatch: Watch | null = null;
      try {
        const watches = await listWatches("active");
        existingWatch =
          watches.find(
            (w) =>
              w.showtime.theatre_id === theatre_id &&
              w.showtime.showtime_id === showtime_id,
          ) ?? null;
      } catch {
        existingWatch = null;
      }
      setAuth({ kind: "signed-in", user, existingWatch });
      if (existingWatch) {
        // reflect the existing notify_any_seat in the UI toggle
        setNotifyAnySeat(existingWatch.notify_any_seat);
      }
    } catch {
      setAuth({ kind: "signed-out" });
    }
  }, [theatre_id, showtime_id]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  // --- live event stream -------------------------------------------------
  const [tickerItems, setTickerItems] = useState<TickerItem[]>([]);
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const onLiveEvent = useCallback((event: ShowtimeEvent): void => {
    if (event.type !== "seat_available") return;
    const { seat_key, seat_label } = event;

    // 1. Flip the seat status in the rendered layout.
    setLayout((prev) => applySeatEvent(prev, seat_key, "Available").layout);

    // 2. Mark the seat as flashing (auto-clears after FLASH_DURATION_MS).
    setFlashIds((prev) => {
      if (prev.has(seat_key)) return prev;
      const next = new Set(prev);
      next.add(seat_key);
      return next;
    });
    const prevTimer = flashTimersRef.current.get(seat_key);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      setFlashIds((prev) => {
        if (!prev.has(seat_key)) return prev;
        const next = new Set(prev);
        next.delete(seat_key);
        return next;
      });
      flashTimersRef.current.delete(seat_key);
    }, FLASH_DURATION_MS);
    flashTimersRef.current.set(seat_key, timer);

    // 3. Push onto the ticker (cap, oldest drops off the top).
    setTickerItems((prev) => {
      const detectedAt = (() => {
        const t = Date.parse(event.detected_at);
        return Number.isFinite(t) ? t : Date.now();
      })();
      const id = `${seat_key}@${detectedAt}`;
      // De-dupe rapid duplicates of the same event id.
      const filtered = prev.filter((it) => it.id !== id);
      const next = [...filtered, { id, seatLabel: seat_label, detectedAt }];
      return next.slice(-TICKER_MAX * 3); // keep a small buffer, ticker trims display
    });
  }, []);

  // Drop ticker items past TTL so memory doesn't grow on a long session.
  useEffect(() => {
    if (tickerItems.length === 0) return;
    const handle = window.setInterval(() => {
      const cutoff = Date.now() - TICKER_TTL_MS;
      setTickerItems((prev) => {
        const next = prev.filter((it) => it.detectedAt >= cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, 4000);
    return () => window.clearInterval(handle);
  }, [tickerItems.length]);

  // Clear timers on unmount.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // TEST FIXTURE — detect the preview showtime so we can swap the live source.
  const isTest = isTestShowtimeUuid(showtime.id);

  const { status: realWsStatus } = useShowtimeEvents({
    showtimeUuid: showtime.id,
    enabled:
      showtime.is_active && !initial.is_post_showtime && !isTest,
    onEvent: onLiveEvent,
  });

  // TEST FIXTURE — fake event emitter: when the showtime is the preview one,
  // every ~6.5s flip a random still-Occupied seat to Available, routed
  // through the same `onLiveEvent` handler so the UX is identical.
  const layoutRef = useRef<SeatMapLayout>(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    if (!isTest) return;
    const handle = window.setInterval(() => {
      const occupied: SeatDetail[] = [];
      for (const row of layoutRef.current.rows) {
        for (const seat of row.seats) {
          if (seat.status === "Occupied") occupied.push(seat);
        }
      }
      if (occupied.length === 0) return;
      const choice = occupied[Math.floor(Math.random() * occupied.length)];
      if (!choice) return;
      onLiveEvent({
        type: "seat_available",
        showtime_uuid: showtime.id,
        theatre_id: showtime.theatre_id,
        showtime_id: showtime.showtime_id,
        seat_key: choice.id,
        seat_label: choice.label,
        detected_at: new Date().toISOString(),
      });
    }, 6500);
    return () => window.clearInterval(handle);
  }, [
    isTest,
    onLiveEvent,
    showtime.id,
    showtime.theatre_id,
    showtime.showtime_id,
  ]);

  // TEST FIXTURE — present the connection as live during a preview session.
  const wsStatus: WsStatus = isTest ? "open" : realWsStatus;

  // --- derived data -----------------------------------------------------
  const seatLookup = useMemo<Map<string, SeatDetail>>(() => {
    const map = new Map<string, SeatDetail>();
    for (const row of layout.rows) {
      for (const seat of row.seats) {
        map.set(seat.id, seat);
      }
    }
    return map;
  }, [layout]);

  const watchedIds = useMemo<Set<string>>(() => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) {
      return new Set();
    }
    return new Set(auth.existingWatch.seats.map((s) => s.seat_key));
  }, [auth]);

  // Strip already-watched seats out of the local selection — they're locked.
  const newSelectionIds = useMemo<string[]>(() => {
    return [...selectedIds].filter((id) => !watchedIds.has(id));
  }, [selectedIds, watchedIds]);

  const newSelectionLabels = useMemo<string[]>(() => {
    return newSelectionIds
      .map((id) => seatLookup.get(id)?.label ?? id)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [newSelectionIds, seatLookup]);

  const watchedLabels = useMemo<string[]>(() => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) return [];
    return auth.existingWatch.seats
      .map((s) => s.seat_label)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [auth]);

  // --- submission -------------------------------------------------------
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const canSubmit =
    auth.kind === "signed-in" &&
    submit.kind !== "submitting" &&
    (newSelectionIds.length > 0 ||
      (notifyAnySeat &&
        (!auth.existingWatch || !auth.existingWatch.notify_any_seat)));

  const onToggleSeat = useCallback(
    (seat: SeatDetail): void => {
      if (watchedIds.has(seat.id)) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(seat.id)) {
          next.delete(seat.id);
        } else {
          next.add(seat.id);
        }
        return next;
      });
      // clear any prior submit error/success when the user resumes editing
      if (submit.kind !== "idle" && submit.kind !== "submitting") {
        setSubmit({ kind: "idle" });
      }
    },
    [watchedIds, submit.kind],
  );

  const onSubmit = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in") return;
    setSubmit({ kind: "submitting" });

    try {
      let watch = auth.existingWatch;

      // create-the-watch step
      if (!watch) {
        watch = await createWatch({
          theatre_id,
          showtime_id,
          notify_any_seat: notifyAnySeat,
        });
      }

      // add-seats step (idempotent on the backend)
      if (newSelectionIds.length > 0) {
        const seats = newSelectionIds
          .map((id) => {
            const seat = seatLookup.get(id);
            if (!seat) return null;
            return { seat_key: seat.id, seat_label: seat.label };
          })
          .filter(
            (s): s is { seat_key: string; seat_label: string } => s !== null,
          );
        if (seats.length > 0) {
          watch = await addSeatsToWatch(watch.id, seats);
        }
      }

      setSelectedIds(new Set());
      saveStoredSelection(theatre_id, showtime_id, new Set());
      setSubmit({ kind: "ok", watch });
      setAuth({ kind: "signed-in", user: auth.user, existingWatch: watch });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't save your watch. Try again in a moment.";
      setSubmit({ kind: "error", message });
    }
  }, [
    auth,
    notifyAnySeat,
    newSelectionIds,
    seatLookup,
    theatre_id,
    showtime_id,
  ]);

  const onCancelWatch = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) return;
    setSubmit({ kind: "submitting" });
    try {
      await cancelWatch(auth.existingWatch.id);
      setAuth({ kind: "signed-in", user: auth.user, existingWatch: null });
      setSubmit({ kind: "idle" });
      setNotifyAnySeat(false);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't cancel that watch.";
      setSubmit({ kind: "error", message });
    }
  }, [auth]);

  const liveEnabled = showtime.is_active && !initial.is_post_showtime;

  return (
    <>
      <div className={styles.liveBar}>
        <span className={styles.liveLabel}>Live updates</span>
        <span className={styles.liveRule} aria-hidden="true" />
        {liveEnabled ? (
          <LiveStatusPill
            status={wsStatus}
            liveLabel="Streaming"
            technical
          />
        ) : (
          <LiveStatusPill status="closed" technical />
        )}
      </div>

      <div className={styles.mapWrap}>
        <SeatMap
          layout={layout}
          selectedIds={selectedIds}
          watchedIds={watchedIds}
          flashIds={flashIds}
          onSeatToggle={onToggleSeat}
        />
        <LiveSeatTicker
          items={tickerItems}
          max={TICKER_MAX}
          ttlMs={TICKER_TTL_MS}
        />
      </div>

      <ActionPanel
        auth={auth}
        notifyAnySeat={notifyAnySeat}
        onNotifyAnySeatChange={setNotifyAnySeat}
        watchedLabels={watchedLabels}
        newSelectionLabels={newSelectionLabels}
        newSelectionCount={newSelectionIds.length}
        canSubmit={canSubmit}
        submit={submit}
        onSubmit={onSubmit}
        onCancelWatch={onCancelWatch}
      />
    </>
  );
}

// --- action panel sub-component ------------------------------------------

function ActionPanel({
  auth,
  notifyAnySeat,
  onNotifyAnySeatChange,
  watchedLabels,
  newSelectionLabels,
  newSelectionCount,
  canSubmit,
  submit,
  onSubmit,
  onCancelWatch,
}: {
  auth: AuthState;
  notifyAnySeat: boolean;
  onNotifyAnySeatChange: (v: boolean) => void;
  watchedLabels: string[];
  newSelectionLabels: string[];
  newSelectionCount: number;
  canSubmit: boolean;
  submit: SubmitState;
  onSubmit: () => void;
  onCancelWatch: () => void;
}): JSX.Element {
  const hasExisting = auth.kind === "signed-in" && Boolean(auth.existingWatch);
  const isSubmitting = submit.kind === "submitting";
  const notifyToggleDisabled =
    hasExisting && auth.kind === "signed-in" && auth.existingWatch !== null;

  let ctaLabel: string;
  if (hasExisting) {
    if (newSelectionCount === 0) {
      ctaLabel = "Saved";
    } else {
      ctaLabel = `Add ${newSelectionCount} to your watch`;
    }
  } else if (newSelectionCount === 0 && notifyAnySeat) {
    ctaLabel = "Start watching any open seat";
  } else if (newSelectionCount === 0) {
    ctaLabel = "Pick at least one seat";
  } else {
    ctaLabel = `Start watching ${newSelectionCount} seat${newSelectionCount === 1 ? "" : "s"}`;
  }

  return (
    <section className={styles.panel} aria-label="Watch setup">
      <div className={styles.header}>
        <span className={styles.kicker}>Watch setup</span>
        {hasExisting ? (
          <span className={styles.statusFlag}>
            <span className={styles.flagDot} aria-hidden="true" />
            Already watching this showtime
          </span>
        ) : null}
      </div>

      <div className={styles.grid}>
        <div className={styles.selectionCol}>
          {hasExisting && watchedLabels.length > 0 ? (
            <div className={styles.watchedBlock}>
              <span className={styles.smallLabel}>Already watching</span>
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

          <div className={styles.numeralBlock}>
            <span className={styles.numeral}>{newSelectionCount}</span>
            <span className={styles.numeralLabel}>
              {newSelectionCount === 1 ? "seat picked" : "seats picked"}
              {hasExisting && newSelectionCount > 0 ? " to add" : ""}
            </span>
          </div>

          {newSelectionLabels.length > 0 ? (
            <ul className={styles.chipList}>
              {newSelectionLabels.map((label) => (
                <li className={styles.seatChip} key={`s-${label}`}>
                  {label}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>
              Tap any seat on the map to start picking — occupied seats too. We
              ping you when a watched seat opens up.
            </p>
          )}
        </div>

        <div className={styles.controlsCol}>
          <label
            className={`${styles.toggle} ${notifyToggleDisabled ? styles.toggleDisabled : ""}`}
          >
            <input
              type="checkbox"
              checked={notifyAnySeat}
              disabled={notifyToggleDisabled}
              onChange={(e) => onNotifyAnySeatChange(e.target.checked)}
              className={styles.toggleInput}
            />
            <span className={styles.toggleBox} aria-hidden="true">
              <span className={styles.toggleCheck} />
            </span>
            <span className={styles.toggleCopy}>
              <span className={styles.toggleTitle}>
                Notify me about any open seat
              </span>
              <span className={styles.toggleSub}>
                {notifyToggleDisabled
                  ? "Locked while this watch is active — cancel below to change."
                  : "Get an alert the moment any seat in this showtime opens."}
              </span>
            </span>
          </label>

          {auth.kind === "signed-in" ? (
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

              {hasExisting ? (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={onCancelWatch}
                  disabled={isSubmitting}
                >
                  Cancel watch
                </button>
              ) : null}
            </>
          ) : auth.kind === "signed-out" ? (
            <SignedOutPrompt
              count={newSelectionCount}
              notifyAnySeat={notifyAnySeat}
            />
          ) : (
            <div className={styles.loadingHint}>
              <span className={styles.spinner} aria-hidden="true" />
              Checking your session…
            </div>
          )}

          {submit.kind === "ok" ? (
            <div className={styles.success} role="status">
              <span className={styles.successTag}>Saved</span>
              <span>
                {hasExisting
                  ? `${submit.watch.seats.length} seat${submit.watch.seats.length === 1 ? "" : "s"} on watch.`
                  : "We'll alert you the moment a seat opens."}
              </span>
            </div>
          ) : null}

          {submit.kind === "error" ? (
            <div className={styles.error} role="alert">
              <span className={styles.errorTag}>Error</span>
              <span>{submit.message}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SignedOutPrompt({
  count,
  notifyAnySeat,
}: {
  count: number;
  notifyAnySeat: boolean;
}): JSX.Element {
  const ready = count > 0 || notifyAnySeat;
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
