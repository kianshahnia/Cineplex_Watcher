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
  updateWatch,
} from "@/lib/api";
import type {
  CurrentUser,
  SeatDetail,
  SeatMapLayout,
  ShowtimeWithSeats,
  Watch,
} from "@/lib/api";
import { SeatMap } from "../../components/SeatMap";
import { DateTimePicker } from "../../components/DateTimePicker";
import {
  useShowtimeEvents,
  type ShowtimeEvent,
} from "@/hooks/useShowtimeEvents";
import styles from "./WatchInteractive.module.css";

const STORAGE_PREFIX = "cinewatch.selection.";

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
  // User-provided name for this watch (sent on create, editable after).
  const [name, setName] = useState<string>("");
  const [nameSaving, setNameSaving] = useState<boolean>(false);
  // User-picked screening date/time. `dateEnabled` gates whether a date is
  // attached at all (off → null); `showtimeAt` is the naive ISO the wheel
  // picker emits while enabled.
  const [dateEnabled, setDateEnabled] = useState<boolean>(false);
  const [showtimeAt, setShowtimeAt] = useState<string | null>(null);
  const [dateSaving, setDateSaving] = useState<boolean>(false);

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
        // reflect the existing notify_any_seat + name + date in the UI
        setNotifyAnySeat(existingWatch.notify_any_seat);
        setName(existingWatch.name ?? "");
        setShowtimeAt(existingWatch.showtime_at);
        setDateEnabled(existingWatch.showtime_at !== null);
      } else {
        setShowtimeAt(null);
        setDateEnabled(false);
      }
    } catch {
      setAuth({ kind: "signed-out" });
    }
  }, [theatre_id, showtime_id]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  // --- live event stream -------------------------------------------------
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const onLiveEvent = useCallback((event: ShowtimeEvent): void => {
    if (event.type !== "seat_available") return;
    const { seat_key } = event;

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
  }, []);

  // Clear timers on unmount.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Subscribe for the side effect only — incoming events flip + flash seats on
  // the map via `onLiveEvent`. The connection status is no longer surfaced in
  // the UI, so we don't read the return value.
  useShowtimeEvents({
    showtimeUuid: showtime.id,
    enabled: showtime.is_active && !initial.is_post_showtime,
    onEvent: onLiveEvent,
  });

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

  // The existing watch for this showtime (if any) and whether its mode is
  // locked. A watch's "all seats" flag (notify_any_seat) can't be changed
  // after creation — the backend has no PATCH for it — so once a watch exists
  // the mode is fixed and the user must cancel to switch between
  // "watch all seats" and "specific seats".
  const existingWatch = auth.kind === "signed-in" ? auth.existingWatch : null;
  const watchAllLocked = existingWatch !== null;

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
    (existingWatch
      ? newSelectionIds.length > 0
      : notifyAnySeat || newSelectionIds.length > 0);

  // Set one seat's picked state. `select` is decided by the SeatMap: a single
  // click toggles (passes !wasSelected); a click-drag paints every crossed seat
  // to the same value. Either way the parent just adds/removes from the set.
  const onPaintSeat = useCallback(
    (seatId: string, select: boolean): void => {
      if (watchedIds.has(seatId)) return;
      // An existing "watch all seats" watch is locked — picking is a no-op.
      if (notifyAnySeat && watchAllLocked) return;
      // Picking a specific seat on a new watch exits "watch all" mode; the two
      // are mutually exclusive so the summary and submit payload stay clear.
      if (select && notifyAnySeat && !watchAllLocked) setNotifyAnySeat(false);
      setSelectedIds((prev) => {
        if (prev.has(seatId) === select) return prev; // already in target state
        const next = new Set(prev);
        if (select) {
          next.add(seatId);
        } else {
          next.delete(seatId);
        }
        return next;
      });
      // clear any prior submit error/success when the user resumes editing
      if (submit.kind !== "idle" && submit.kind !== "submitting") {
        setSubmit({ kind: "idle" });
      }
    },
    [watchedIds, notifyAnySeat, watchAllLocked, submit.kind],
  );

  const clearSubmitNotice = useCallback((): void => {
    setSubmit((s) =>
      s.kind !== "idle" && s.kind !== "submitting" ? { kind: "idle" } : s,
    );
  }, []);

  const onToggleWatchAll = useCallback((): void => {
    if (watchAllLocked) return;
    setNotifyAnySeat((prev) => {
      const next = !prev;
      // "Watch all seats" makes individual picks redundant — clear them so the
      // summary and the submit payload are unambiguous.
      if (next) setSelectedIds(new Set());
      return next;
    });
    clearSubmitNotice();
  }, [watchAllLocked, clearSubmitNotice]);

  const onClearSelection = useCallback((): void => {
    setSelectedIds(new Set());
    clearSubmitNotice();
  }, [clearSubmitNotice]);

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
          name: name.trim() || null,
          showtime_at: dateEnabled ? showtimeAt : null,
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
    name,
    dateEnabled,
    showtimeAt,
    newSelectionIds,
    seatLookup,
    theatre_id,
    showtime_id,
  ]);

  const onSaveName = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) return;
    setNameSaving(true);
    try {
      const updated = await updateWatch(auth.existingWatch.id, {
        name: name.trim() || null,
      });
      setAuth({ kind: "signed-in", user: auth.user, existingWatch: updated });
      setName(updated.name ?? "");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't save that name.";
      setSubmit({ kind: "error", message });
    } finally {
      setNameSaving(false);
    }
  }, [auth, name]);

  const onToggleDate = useCallback((): void => {
    setDateEnabled((prev) => {
      const next = !prev;
      // Turning it off clears the value; turning it on lets the picker seed
      // `showtimeAt` via its mount emit.
      if (!next) setShowtimeAt(null);
      return next;
    });
    clearSubmitNotice();
  }, [clearSubmitNotice]);

  const onSaveDate = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) return;
    setDateSaving(true);
    try {
      const updated = await updateWatch(auth.existingWatch.id, {
        showtime_at: dateEnabled ? showtimeAt : null,
      });
      setAuth({ kind: "signed-in", user: auth.user, existingWatch: updated });
      setShowtimeAt(updated.showtime_at);
      setDateEnabled(updated.showtime_at !== null);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't save that date.";
      setSubmit({ kind: "error", message });
    } finally {
      setDateSaving(false);
    }
  }, [auth, dateEnabled, showtimeAt]);

  const onCancelWatch = useCallback(async (): Promise<void> => {
    if (auth.kind !== "signed-in" || !auth.existingWatch) return;
    setSubmit({ kind: "submitting" });
    try {
      await cancelWatch(auth.existingWatch.id);
      setAuth({ kind: "signed-in", user: auth.user, existingWatch: null });
      setSubmit({ kind: "idle" });
      setNotifyAnySeat(false);
      setShowtimeAt(null);
      setDateEnabled(false);
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

  // --- date field (built here so prop-threading through ActionPanel stays
  // shallow — it's rendered as an opaque node in the controls column).
  const committedDate = existingWatch?.showtime_at ?? null;
  const effectiveDate = dateEnabled ? showtimeAt : null;
  const normDate = (s: string | null): string | null => (s ? s.slice(0, 16) : null);
  const dateDirty =
    existingWatch !== null && normDate(effectiveDate) !== normDate(committedDate);

  const dateField =
    auth.kind === "signed-in" ? (
      <DateField
        enabled={dateEnabled}
        onToggle={onToggleDate}
        initialValue={existingWatch?.showtime_at ?? null}
        pickerKey={existingWatch?.id ?? "new"}
        onChange={setShowtimeAt}
        hasExisting={existingWatch !== null}
        dirty={dateDirty}
        saving={dateSaving}
        onSave={onSaveDate}
      />
    ) : null;

  return (
    <>
      <SeatMap
        layout={layout}
        selectedIds={selectedIds}
        watchedIds={watchedIds}
        flashIds={flashIds}
        onSeatPaint={onPaintSeat}
      />

      <ActionPanel
        auth={auth}
        name={name}
        onNameChange={setName}
        onSaveName={onSaveName}
        nameSaving={nameSaving}
        dateField={dateField}
        watchAll={notifyAnySeat}
        watchAllLocked={watchAllLocked}
        onToggleWatchAll={onToggleWatchAll}
        watchedLabels={watchedLabels}
        newSelectionLabels={newSelectionLabels}
        newSelectionCount={newSelectionIds.length}
        onClearSelection={onClearSelection}
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
  name,
  onNameChange,
  onSaveName,
  nameSaving,
  dateField,
  watchAll,
  watchAllLocked,
  onToggleWatchAll,
  watchedLabels,
  newSelectionLabels,
  newSelectionCount,
  onClearSelection,
  canSubmit,
  submit,
  onSubmit,
  onCancelWatch,
}: {
  auth: AuthState;
  name: string;
  onNameChange: (v: string) => void;
  onSaveName: () => void;
  nameSaving: boolean;
  dateField: JSX.Element | null;
  watchAll: boolean;
  watchAllLocked: boolean;
  onToggleWatchAll: () => void;
  watchedLabels: string[];
  newSelectionLabels: string[];
  newSelectionCount: number;
  onClearSelection: () => void;
  canSubmit: boolean;
  submit: SubmitState;
  onSubmit: () => void;
  onCancelWatch: () => void;
}): JSX.Element {
  const existing = auth.kind === "signed-in" ? auth.existingWatch : null;
  const hasExisting = existing !== null;
  const existingIsAll = existing?.notify_any_seat === true;
  const existingIsSpecific = hasExisting && !existingIsAll;
  const creating = auth.kind === "signed-in" && !hasExisting;
  const isSignedIn = auth.kind === "signed-in";
  const isSubmitting = submit.kind === "submitting";

  const committedName = existing?.name ?? "";
  const nameDirty = hasExisting && name.trim() !== committedName.trim();

  let ctaLabel: string;
  if (existingIsAll) {
    ctaLabel = "Watching all seats";
  } else if (existingIsSpecific) {
    ctaLabel =
      newSelectionCount > 0
        ? `Add ${newSelectionCount} seat${newSelectionCount === 1 ? "" : "s"}`
        : "Saved";
  } else if (watchAll) {
    ctaLabel = "Start watching all seats";
  } else if (newSelectionCount > 0) {
    ctaLabel = `Start watching ${newSelectionCount} seat${newSelectionCount === 1 ? "" : "s"}`;
  } else {
    ctaLabel = "Pick seats or watch all";
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
        {/* LEFT — what to watch */}
        <div className={styles.selectionCol}>
          {existingIsAll ? (
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
                count={newSelectionCount}
                labels={newSelectionLabels}
                onClear={onClearSelection}
                addMode
              />
            </>
          ) : creating ? (
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
                    count={newSelectionCount}
                    labels={newSelectionLabels}
                    onClear={onClearSelection}
                  />
                </>
              ) : null}
            </>
          ) : (
            // signed-out / loading — let them preview picks
            <SelectionSummary
              count={newSelectionCount}
              labels={newSelectionLabels}
              onClear={onClearSelection}
            />
          )}
        </div>

        {/* RIGHT — name + commit */}
        <div className={styles.controlsCol}>
          {isSignedIn ? (
            <>
              <div className={styles.nameField}>
                <label className={styles.nameLabel} htmlFor="watch-name">
                  Name this showtime
                </label>
                <div className={styles.nameInputRow}>
                  <input
                    id="watch-name"
                    type="text"
                    className={styles.nameInput}
                    value={name}
                    maxLength={120}
                    placeholder="e.g. Dune: Part Two — Fri 7pm"
                    onChange={(e) => onNameChange(e.target.value)}
                  />
                  {hasExisting ? (
                    <button
                      type="button"
                      className={styles.nameSaveBtn}
                      onClick={onSaveName}
                      disabled={!nameDirty || nameSaving}
                    >
                      {nameSaving ? "Saving…" : "Save"}
                    </button>
                  ) : null}
                </div>
              </div>

              {dateField}

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

              <div className={styles.commitFooter}>
                {submit.kind === "error" ? (
                  <span className={styles.statusError} role="alert">
                    {submit.message}
                  </span>
                ) : submit.kind === "ok" ? (
                  <span className={styles.statusOk} role="status">
                    {existingIsAll
                      ? "Watching every seat."
                      : `Saved — ${submit.watch.seats.length} seat${submit.watch.seats.length === 1 ? "" : "s"} on watch.`}
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
                    Cancel watch
                  </button>
                ) : null}
              </div>
            </>
          ) : auth.kind === "signed-out" ? (
            <SignedOutPrompt count={newSelectionCount} watchAll={watchAll} />
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

// The optional "showtime date & time" control: a toggle that reveals the
// iOS-style wheel picker. For a new watch the chosen date rides along with the
// main "Start watching" submit; for an existing watch a "Save date" button
// commits a change in place (the date is editable any time, like the name).
function DateField({
  enabled,
  onToggle,
  initialValue,
  pickerKey,
  onChange,
  hasExisting,
  dirty,
  saving,
  onSave,
}: {
  enabled: boolean;
  onToggle: () => void;
  initialValue: string | null;
  pickerKey: string;
  onChange: (iso: string) => void;
  hasExisting: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}): JSX.Element {
  return (
    <div className={styles.dateField}>
      <div className={styles.dateHead}>
        <span className={styles.nameLabel}>Showtime date &amp; time</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`${styles.dateToggle} ${enabled ? styles.dateToggleOn : ""}`}
          onClick={onToggle}
        >
          <span className={styles.dateToggleTrack} aria-hidden="true">
            <span className={styles.dateToggleKnob} />
          </span>
          <span className={styles.dateToggleText}>{enabled ? "On" : "Off"}</span>
        </button>
      </div>

      {enabled ? (
        <>
          <DateTimePicker
            key={pickerKey}
            initialValue={initialValue}
            onChange={onChange}
          />
          {hasExisting ? (
            <div className={styles.dateFoot}>
              <button
                type="button"
                className={styles.nameSaveBtn}
                onClick={onSave}
                disabled={!dirty || saving}
              >
                {saving ? "Saving…" : "Save date"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.nameHint}>
          Optional — roll in the screening’s date and time so your alerts and
          watchlist read clearly.
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
