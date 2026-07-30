"use client";

/**
 * SeatMap — controlled SVG renderer for a Cineplex auditorium.
 *
 * - Step 2: read-only render + colour by availability.
 * - Step 3: when `onSeatPaint` is passed, seats become selectable. The parent
 *   owns selection state (`selectedIds`) and committed-watch state
 *   (`watchedIds`) — this component is purely presentational + input.
 *
 * Selection input (when `onSeatPaint` is provided):
 * - Click / tap a seat → toggles it (`onSeatPaint(id, !wasSelected)`).
 * - Click-and-drag (mouse / pen) → "paints" every seat the pointer crosses to
 *   the SAME state, decided by the first seat: starting on an unselected seat
 *   selects the stroke, starting on a selected seat deselects it. This mirrors
 *   spreadsheet / file-explorer drag-select.
 * - Click a **row letter** (either gutter) → selects every selectable seat in
 *   that row, or clears them if they were all already picked (`onBatchPaint`).
 *   A partly-picked row fills rather than clears, same rule the dashboard's
 *   group checkboxes use.
 * - **Select all / Deselect all**, top-left above the grid → the same batch
 *   call over the whole map. This replaced the old "watch all seats" flag,
 *   which committed to every seat and showed nothing for it on the map.
 * - Touch keeps tap-to-toggle only, so vertical/horizontal scrolling of the map
 *   still works with a finger.
 *
 * `statusMode="neutral"` is what the watch page uses: one map stands in for
 * every ticked showtime, and their availability genuinely differs, so any
 * Available/Occupied colouring would be a lie for at least one of them. The one
 * exception is `freeAt`, which warms the fill of seats already open — a fact
 * that holds regardless of which ticked showtime you have in mind. With a
 * single showtime ticked that reduces to plain "this seat is free", which is
 * why the copy is driven by `multiTimes` rather than hard-coded.
 *
 * Seat states are deliberately split across two channels so they never have to
 * compete: **fill** carries what the seat *is* (a seat / free / watched), and
 * **stroke** carries what you or the room did to it (picked / accessible /
 * unknown). That is why a free accessible seat can read as both.
 */
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { RowDetail, SeatDetail, SeatMapLayout } from "@/lib/api";
import {
  bulkSelectState,
  isSelectableSeat,
  rowPaint,
  type BulkSelectState,
} from "@/lib/seatRows";
import styles from "./SeatMap.module.css";

const CELL_W = 22;
const CELL_H = 18;
const GAP_X = 3;
const GAP_Y = 6;
const SCREEN_H = 92;
const AISLE_H = 10;
const BOTTOM_PAD = 16;
// Gutter geometry. The row-label text is anchored at ROW_LABEL_X (near the left
// edge); the seat grid doesn't begin until GRID_PAD_X. The gap between them
// (GRID_PAD_X − ROW_LABEL_X) is what keeps the leftmost seats from crowding the
// row letters — full-width rows run all the way to column 1, so this gap must
// be comfortably wider than a label. Gutters are symmetric, so the seat block
// stays centred. Widen GRID_PAD_X for more breathing room on both sides.
const ROW_LABEL_X = 24;
const GRID_PAD_X = 58;
// Click target around a row letter. A 10px mono glyph is far too small to aim
// at, so an invisible rect spans the whole gutter up to (but never into) the
// seat grid — ROW_HIT_W must stay < GRID_PAD_X or it would swallow seat clicks.
const ROW_HIT_W = 46;

// Pointer must travel this many px before a press becomes a drag-paint (rather
// than a click). Keeps a slightly-shaky single click from painting two seats.
const DRAG_THRESHOLD_PX = 4;

interface RowGeo {
  row: RowDetail;
  y: number;
  height: number;
}

// Live state for one in-progress drag-paint. Held in a ref so paints don't
// trigger re-renders mid-gesture (the parent's selectedIds update does).
interface DragState {
  pointerId: number;
  /** true = selecting, false = deselecting — fixed for the whole stroke. */
  mode: boolean;
  /** seat ids already painted this stroke, so each fires onSeatPaint once. */
  painted: Set<string>;
  /** becomes true once the pointer has moved past the click threshold. */
  started: boolean;
  startId: string;
  startX: number;
  startY: number;
}

/** Empty, stable — shared by every "nothing is free elsewhere" render. */
const NO_FREE: ReadonlyMap<string, string[]> = new Map();

interface SeatMapProps {
  layout: SeatMapLayout;
  selectedIds?: Set<string>;
  watchedIds?: Set<string>;
  /** Seats currently animating their Occupied → Available transition. */
  flashIds?: Set<string>;
  /**
   * `"live"` (default) paints Available/Occupied. `"neutral"` drops that
   * colouring entirely — used when one map stands in for several showtimes.
   */
  statusMode?: "live" | "neutral";
  /**
   * Seat id → the showtime labels where it is already Available. Drives the
   * warm `.free` fill and the tooltip in neutral mode; ignored in live mode,
   * where the Available fill already says it.
   */
  freeAt?: ReadonlyMap<string, string[]>;
  /**
   * Whether this neutral map stands in for more than one showtime. Only affects
   * copy: with one time in play "free" needs no qualifier, with several it has
   * to say *which* — otherwise the fill would claim the seat is open at all of
   * them.
   */
  multiTimes?: boolean;
  /**
   * Greys the whole map out and switches every input off — used when nothing is
   * ticked, so there is no showtime the picks could belong to. The map still
   * renders (the room is worth looking at) but it is explicitly read-only.
   */
  dimmed?: boolean;
  /** Set a seat's picked state. Presence of this prop enables selection. */
  onSeatPaint?: (seatId: string, select: boolean) => void;
  /**
   * Set a batch of seats to the same picked state — a row-letter click, or the
   * Select all / Deselect all controls. Separate from `onSeatPaint` so the
   * parent can apply the batch in a single state update rather than one per
   * seat: the watch page fans every pick across up to 8 ticked showtimes, so
   * per-seat would be (times × row width) Map/Set allocations per click.
   */
  onBatchPaint?: (seatIds: string[], select: boolean) => void;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
}

/** Map a hit-tested DOM element back to a seat, reading data-* attributes. */
function seatHit(
  el: Element | null | undefined,
): { id: string; interactive: boolean } | null {
  const seatEl = el?.closest<Element>("[data-seat-id]");
  if (!seatEl) return null;
  const id = seatEl.getAttribute("data-seat-id");
  if (!id) return null;
  return { id, interactive: seatEl.getAttribute("data-interactive") === "1" };
}

export function SeatMap({
  layout,
  selectedIds,
  watchedIds,
  flashIds,
  statusMode = "live",
  freeAt = NO_FREE,
  multiTimes = false,
  dimmed = false,
  onSeatPaint,
  onBatchPaint,
}: SeatMapProps): JSX.Element {
  const neutral = statusMode === "neutral";
  const cols = layout.total_columns;
  const innerW = cols * CELL_W + Math.max(0, cols - 1) * GAP_X;
  const totalW = GRID_PAD_X * 2 + innerW;

  const rows: RowGeo[] = [];
  let cursorY = SCREEN_H;
  for (const row of layout.rows) {
    const isAisle = row.seats.length === 0;
    const h = isAisle ? AISLE_H : CELL_H;
    rows.push({ row, y: cursorY, height: h });
    cursorY += h + GAP_Y;
  }
  const totalH = cursorY - GAP_Y + BOTTOM_PAD;

  const seatCount = layout.rows.reduce((acc, r) => acc + r.seats.length, 0);
  const availableCount = layout.rows.reduce(
    (acc, r) => acc + r.seats.filter((s) => s.status === "Available").length,
    0,
  );

  // --- drag-paint plumbing ----------------------------------------------
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Set when a real drag ends so the trailing synthetic `click` on the seat
  // under the pointer doesn't toggle it back. Consumed by handleSeatClick.
  const suppressClickRef = useRef(false);

  const paint = (id: string, interactive: boolean, drag: DragState): void => {
    if (!interactive || drag.painted.has(id)) return;
    drag.painted.add(id);
    onSeatPaint?.(id, drag.mode);
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Touch keeps tap-to-toggle (via onClick) so the map can still be scrolled
    // with a finger. Mouse/pen get drag-paint.
    if (!onSeatPaint || dimmed || e.pointerType === "touch" || e.button !== 0) {
      return;
    }
    const hit = seatHit(e.target as Element);
    if (!hit || !hit.interactive) return;
    suppressClickRef.current = false;
    e.preventDefault(); // stop text selection / native image-drag
    dragRef.current = {
      pointerId: e.pointerId,
      mode: !(selectedIds?.has(hit.id) ?? false),
      painted: new Set(),
      started: false,
      startId: hit.id,
      startX: e.clientX,
      startY: e.clientY,
    };
    // NOTE: pointer capture is deliberately NOT taken here. Capturing on
    // pointerdown makes the browser dispatch the trailing `click` on the
    // capturing element (the scroller) instead of the seat <rect>, so a plain
    // click would never reach the rect's onClick. We only capture once a real
    // drag starts (in handlePointerMove), which leaves a pure click untouched.
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      drag.started = true;
      // Now that this is a real drag, capture the pointer so we keep getting
      // moves even if it leaves the map. Doing it here (not on pointerdown)
      // keeps a pure click's `click` event on the seat rect. Capture does not
      // affect elementFromPoint hit-testing below.
      try {
        scrollerRef.current?.setPointerCapture(drag.pointerId);
      } catch {
        // capture can throw if the pointer is already gone — ignore
      }
      paint(drag.startId, true, drag); // origin seat is known-interactive
    }
    const hit = seatHit(document.elementFromPoint(e.clientX, e.clientY));
    if (hit) paint(hit.id, hit.interactive, drag);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.started) suppressClickRef.current = true;
    try {
      scrollerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
  };

  const handleSeatClick = (seat: SeatDetail): void => {
    // Swallow the click synthesized at the end of a drag-paint.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSeatPaint?.(seat.id, !(selectedIds?.has(seat.id) ?? false));
  };

  const interact: SeatInteract = {
    selectedIds,
    watchedIds,
    flashIds,
    neutral,
    freeAt,
    multiTimes,
    enabled: Boolean(onSeatPaint) && !dimmed,
    onSeatClick: handleSeatClick,
    onBatchPaint: dimmed ? undefined : onBatchPaint,
  };

  // --- whole-map selection ------------------------------------------------
  // Cheap enough to recompute every render (one pass over the seats, ~250 of
  // them) and always in step with the props, which memoising would have to be
  // kept honest about by hand.
  const bulk = interact.enabled && onBatchPaint
    ? bulkSelectState(layout.rows, watchedIds, selectedIds)
    : null;

  const freeCount = neutral
    ? layout.rows.reduce(
        (acc, r) => acc + r.seats.filter((s) => freeAt.has(s.id)).length,
        0,
      )
    : 0;

  return (
    <div className={cx(styles.wrap, dimmed && styles.dimmed)}>
      {bulk && onBatchPaint ? (
        <BulkControls state={bulk} onPaint={onBatchPaint} />
      ) : null}
      <div
        className={styles.scroller}
        ref={scrollerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg
          width={totalW}
          height={totalH}
          viewBox={`0 0 ${totalW} ${totalH}`}
          className={styles.svg}
          role="img"
          aria-label={
            dimmed
              ? `Seat map: ${seatCount} seats. No showtime is selected, so seats can't be picked — select a time above.`
              : neutral
                ? multiTimes
                  ? `Seat map: ${seatCount} seats. Availability is not colour-coded because several showtimes are selected; ${freeCount} seats are already open at one of them.`
                  : `Seat map: ${seatCount} seats, ${freeCount} of them already free.`
                : `Seat map: ${availableCount} of ${seatCount} seats available across ${layout.rows.filter((r) => r.seats.length > 0).length} rows`
          }
        >
          <defs>
            <linearGradient id="cw-screen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(214, 219, 228, 0.78)" />
              <stop offset="100%" stopColor="rgba(214, 219, 228, 0.05)" />
            </linearGradient>
            <linearGradient id="cw-spill" x1="0.5" y1="0" x2="0.5" y2="1">
              <stop offset="0%" stopColor="rgba(214, 219, 228, 0.16)" />
              <stop offset="100%" stopColor="rgba(214, 219, 228, 0)" />
            </linearGradient>
          </defs>

          {renderScreen(totalW)}
          {rows.map(({ row, y, height }) =>
            renderRow(row, y, height, totalW, interact),
          )}
        </svg>
      </div>
      <SeatLegend
        total={seatCount}
        available={availableCount}
        occupied={seatCount - availableCount}
        showWatched={Boolean(watchedIds && watchedIds.size > 0) || Boolean(onSeatPaint)}
        neutral={neutral}
        multiTimes={multiTimes}
        dimmed={dimmed}
        freeCount={freeCount}
      />
    </div>
  );
}

/**
 * Select all / Deselect all, top-left above the grid.
 *
 * Two explicit buttons rather than one toggle, because each one says what it
 * will do — and because the pair replaced the "watch all seats" flag, whose
 * whole problem was that committing to every seat left the map looking
 * untouched. These paint real picks, so the room lights up.
 *
 * Rendered only when selection is on: a read-only or dimmed map has nothing for
 * them to act on, and an always-present pair of disabled buttons is clutter.
 */
function BulkControls({
  state,
  onPaint,
}: {
  state: BulkSelectState;
  onPaint: (seatIds: string[], select: boolean) => void;
}): JSX.Element | null {
  const { seatIds, pickedCount } = state;
  if (seatIds.length === 0) return null;
  const allPicked = pickedCount === seatIds.length;
  const remaining = seatIds.length - pickedCount;

  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.toolbarBtn}
        onClick={() => onPaint(seatIds, true)}
        disabled={allPicked}
        title={
          allPicked
            ? "Every selectable seat is already picked"
            : `Pick ${remaining} more ${remaining === 1 ? "seat" : "seats"}`
        }
      >
        Select all
      </button>
      <button
        type="button"
        className={styles.toolbarBtn}
        onClick={() => onPaint(seatIds, false)}
        disabled={pickedCount === 0}
        title={
          pickedCount === 0
            ? "Nothing picked yet"
            : `Clear ${pickedCount} picked ${pickedCount === 1 ? "seat" : "seats"}`
        }
      >
        Deselect all
      </button>
      {/* The one number worth showing: how big "all" actually is. Seats already
          committed to a watch aren't in it — neither button can move them. */}
      <span className={styles.toolbarCount}>
        {pickedCount} / {seatIds.length} picked
      </span>
    </div>
  );
}

function renderScreen(totalW: number): JSX.Element {
  const cx = totalW / 2;
  const arcWidth = Math.min(totalW * 0.55, 380);
  const spillSpread = Math.min(totalW * 0.35, 240);

  return (
    <g aria-hidden="true">
      <path
        d={`M ${cx - spillSpread / 3} 28 L 40 ${SCREEN_H - 6} L ${totalW - 40} ${SCREEN_H - 6} L ${cx + spillSpread / 3} 28 Z`}
        fill="url(#cw-spill)"
        opacity="0.55"
      />
      <ellipse
        cx={cx}
        cy={28}
        rx={arcWidth / 2}
        ry={3.5}
        fill="url(#cw-screen)"
      />
      <line
        x1={cx - arcWidth / 2}
        y1={32}
        x2={cx + arcWidth / 2}
        y2={32}
        stroke="rgba(214, 219, 228, 0.18)"
        strokeWidth={1}
      />
      <text x={cx} y={54} textAnchor="middle" className={styles.screenLabel}>
        SCREEN
      </text>
    </g>
  );
}

interface SeatInteract {
  selectedIds?: Set<string>;
  watchedIds?: Set<string>;
  flashIds?: Set<string>;
  /** True when availability colouring is suppressed. */
  neutral?: boolean;
  freeAt?: ReadonlyMap<string, string[]>;
  /** True when the neutral map stands in for more than one showtime. */
  multiTimes?: boolean;
  /** Whether selection is enabled (onSeatPaint was provided, and not dimmed). */
  enabled?: boolean;
  onSeatClick?: (seat: SeatDetail) => void;
  onBatchPaint?: (seatIds: string[], select: boolean) => void;
}

/**
 * Whether a seat accepts input here: the shared `isSelectableSeat` rule, plus
 * this map's own on/off switch. Same rule the row-letter click resolves against
 * (`lib/seatRows.ts:rowPaint`), so a row click can never try to paint a seat the
 * rect itself would refuse.
 */
function isSeatInteractive(seat: SeatDetail, interact: SeatInteract): boolean {
  if (!interact.enabled) return false;
  return isSelectableSeat(seat, interact.watchedIds);
}

/** "3:00 PM", "3:00 PM and 7:00 PM", "3:00 PM, 7:00 PM and 11:00 PM". */
function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function renderRow(
  row: RowDetail,
  y: number,
  height: number,
  totalW: number,
  interact: SeatInteract,
): JSX.Element | null {
  if (row.seats.length === 0) {
    return null;
  }
  const centerY = y + height / 2;

  // --- row-letter click ---------------------------------------------------
  // `null` when the row offers nothing selectable (all locked, all unknown) —
  // then no affordance is rendered at all, rather than a dead target.
  const rowIntent =
    interact.enabled && interact.onBatchPaint
      ? rowPaint(row.seats, interact.watchedIds, interact.selectedIds)
      : null;
  const onBatchPaint = interact.onBatchPaint;
  const rowEnabled = rowIntent !== null;
  const paintRow = (): void => {
    if (!rowIntent || !onBatchPaint) return;
    onBatchPaint(rowIntent.seatIds, rowIntent.select);
  };
  const onRowKeyDown = (e: ReactKeyboardEvent<SVGGElement>): void => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // Space would otherwise scroll the page
    paintRow();
  };
  // Only the left letter is a keyboard target. The right one is a duplicate for
  // reading long rows, and making both focusable would put two tab stops per row
  // in front of a panel a keyboard user is trying to reach.
  const rowLabelProps = (primary: boolean): Record<string, unknown> => {
    if (!rowEnabled) return {};
    return {
      className: styles.rowLabelBtn,
      onClick: paintRow,
      ...(primary
        ? {
            onKeyDown: onRowKeyDown,
            role: "button",
            tabIndex: 0,
            "aria-label": `${rowIntent?.select ? "Select" : "Clear"} every seat in row ${row.label}`,
          }
        : { "aria-hidden": true }),
    };
  };

  const rowLabel = (
    x: number,
    anchor: "start" | "end",
    primary: boolean,
  ): JSX.Element => (
    <g {...rowLabelProps(primary)}>
      {/* Invisible, generously-sized hit area: a 10px glyph is not a target.
          `fill: transparent` still hit-tests (unlike `fill: none`). */}
      {rowEnabled ? (
        <rect
          x={anchor === "end" ? 0 : totalW - ROW_HIT_W}
          y={y - 2}
          width={ROW_HIT_W}
          height={height + 4}
          rx={3}
          className={styles.rowHit}
        />
      ) : null}
      <text
        x={x}
        y={centerY}
        textAnchor={anchor}
        dominantBaseline="central"
        className={styles.rowLabel}
      >
        {row.label}
      </text>
    </g>
  );

  return (
    <g key={row.number}>
      {rowLabel(ROW_LABEL_X, "end", true)}
      {rowLabel(totalW - ROW_LABEL_X, "start", false)}
      {row.seats.map((seat) => (
        <Seat
          key={seat.id}
          seat={seat}
          x={GRID_PAD_X + (seat.column - 1) * (CELL_W + GAP_X)}
          y={y}
          interact={interact}
        />
      ))}
    </g>
  );
}

function Seat({
  seat,
  x,
  y,
  interact,
}: {
  seat: SeatDetail;
  x: number;
  y: number;
  interact: SeatInteract;
}): JSX.Element {
  const isAvailable = seat.status === "Available";
  const isOccupied = seat.status === "Occupied";
  const isUnknown = !isAvailable && !isOccupied;
  const isSpecial = seat.type === "Wheelchair" || seat.type === "Companion";
  const neutral = Boolean(interact.neutral);

  const isSelected = interact.selectedIds?.has(seat.id) ?? false;
  const isWatched = interact.watchedIds?.has(seat.id) ?? false;
  const justOpened = interact.flashIds?.has(seat.id) ?? false;
  const isFlashing = !neutral && justOpened;
  const isInteractive = isSeatInteractive(seat, interact);
  // Only meaningful in neutral mode: in live mode the fill already says it.
  const freeLabels = neutral ? interact.freeAt?.get(seat.id) : undefined;
  const isFree = Boolean(freeLabels && freeLabels.length > 0);

  // In neutral mode every known seat gets the same fill — the whole point is
  // that we are not claiming a status. Unknown seats keep their dashed outline
  // because "this seat isn't in the availability map" is still true.
  const stateClass = neutral
    ? isUnknown
      ? styles.unknown
      : styles.neutral
    : isAvailable
      ? styles.available
      : isOccupied
        ? styles.occupied
        : styles.unknown;

  const className = cx(
    styles.seat,
    stateClass,
    // Free is a *fill* — the one visual channel not already spoken for. Picked,
    // watching, accessible and unknown all live on the stroke, so `.free` never
    // has to compete with any of them, and a free accessible seat reads as
    // both. `.selected` / `.watched` outrank it on specificity, which is right:
    // what you did with a seat matters more than what it already was.
    isFree && styles.free,
    isSpecial && styles.special,
    isSelected && styles.selected,
    isWatched && styles.watched,
    isFlashing && styles.flashing,
    // Neutral mode can't flash the *status* (it isn't claiming one), so a live
    // Occupied → Available settles into the free fill instead.
    neutral && justOpened && isFree && styles.freeFlash,
    isInteractive && styles.interactive,
  );

  // With one showtime in play "free" stands alone; with several the tooltip has
  // to name which ones, or it would read as "open at all of them".
  const freeNote = !isFree
    ? null
    : interact.multiTimes
      ? `already free at ${joinLabels(freeLabels ?? [])}`
      : "free";

  const tooltipParts = [
    seat.label,
    neutral ? null : seat.status,
    freeNote,
    (isFlashing || (neutral && justOpened && isFree)) && "just opened",
    isWatched && "already watching",
    isSelected && "selected",
    isSpecial && seat.type,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  const tooltip = tooltipParts.join(" · ");

  const rect = (
    <rect
      x={x}
      y={y}
      width={CELL_W}
      height={CELL_H}
      rx={3}
      ry={3}
      className={className}
      data-seat-id={seat.id}
      data-interactive={isInteractive ? "1" : undefined}
      onClick={
        isInteractive && interact.onSeatClick
          ? () => interact.onSeatClick!(seat)
          : undefined
      }
    >
      <title>{tooltip}</title>
    </rect>
  );

  // The warm fill and the dot say the same thing together. A watched seat is
  // solid brass, so a brass dot on it would be invisible anyway — and the fill
  // already says "watching" on its own.
  if (!isFree || isWatched) return rect;

  return (
    <>
      {rect}
      {/* `pointer-events: none` keeps the dot out of hit-testing, so both the
          click handler and the drag-paint's elementFromPoint still resolve to
          the rect underneath — and the rect's <title> still wins the tooltip. */}
      <circle
        cx={x + CELL_W / 2}
        cy={y + CELL_H / 2}
        r={2.4}
        className={styles.freeMark}
      />
    </>
  );
}

function SeatLegend({
  total,
  available,
  occupied,
  showWatched,
  neutral,
  multiTimes,
  dimmed,
  freeCount,
}: {
  total: number;
  available: number;
  occupied: number;
  showWatched: boolean;
  neutral: boolean;
  multiTimes: boolean;
  dimmed: boolean;
  freeCount: number;
}): JSX.Element {
  return (
    <div className={styles.legendRow}>
      <ul className={styles.legend}>
        {neutral ? (
          <>
            <li className={styles.legendItem}>
              <span
                className={`${styles.chip} ${styles.chipNeutral}`}
                aria-hidden="true"
              />
              Seat
            </li>
            <li className={styles.legendItem}>
              <span
                className={`${styles.chip} ${styles.chipFree}`}
                aria-hidden="true"
              />
              {multiTimes ? "Free at one of these times" : "Free"}
            </li>
          </>
        ) : (
          <>
            <li className={styles.legendItem}>
              <span className={`${styles.chip} ${styles.chipAvailable}`} aria-hidden="true" />
              Available
            </li>
            <li className={styles.legendItem}>
              <span className={`${styles.chip} ${styles.chipOccupied}`} aria-hidden="true" />
              Occupied
            </li>
          </>
        )}
        <li className={styles.legendItem}>
          <span className={`${styles.chip} ${styles.chipSpecial}`} aria-hidden="true" />
          Accessible
        </li>
        {showWatched ? (
          <>
            <li className={styles.legendItem}>
              <span
                className={`${styles.chip} ${styles.chipSelected}`}
                aria-hidden="true"
              />
              Picked
            </li>
            <li className={styles.legendItem}>
              <span
                className={`${styles.chip} ${styles.chipWatched}`}
                aria-hidden="true"
              />
              Watching
            </li>
          </>
        ) : null}
      </ul>
      {/* The tally is counted off `freeAt`, never off the layout's own statuses:
          in neutral mode the layout is a stand-in and its statuses belong to
          whichever showtime happened to supply it. With several times ticked an
          open/taken split would be meaningless, so only the free count is shown;
          with one, "taken" is exactly the rest of the room. With *none* there is
          no availability to report at all — and "0 free / N taken" would be a
          false claim, dimmed or not — so it states only the size of the room. */}
      {dimmed ? (
        <div className={styles.tally}>
          <span className={styles.tallyNumber}>{total}</span>
          <span className={styles.tallyLabel}>seats</span>
          <span className={styles.tallyDot} aria-hidden="true" />
          <span className={styles.tallyDim}>no showtime selected</span>
        </div>
      ) : neutral ? (
        <div className={styles.tally}>
          <span className={styles.tallyNumber}>{freeCount}</span>
          {multiTimes ? (
            <>
              <span className={styles.tallyLabel}>
                {freeCount === 1 ? "seat already free" : "seats already free"}
              </span>
              <span className={styles.tallyDot} aria-hidden="true" />
              <span className={styles.tallyDim}>at one of these times</span>
            </>
          ) : (
            <>
              <span className={styles.tallySep}>/</span>
              <span className={styles.tallyTotal}>{total}</span>
              <span className={styles.tallyLabel}>seats free</span>
              <span className={styles.tallyDot} aria-hidden="true" />
              <span className={styles.tallyDim}>{total - freeCount} taken</span>
            </>
          )}
        </div>
      ) : (
        <div className={styles.tally}>
          <span className={styles.tallyNumber}>{available}</span>
          <span className={styles.tallySep}>/</span>
          <span className={styles.tallyTotal}>{total}</span>
          <span className={styles.tallyLabel}>seats open</span>
          <span className={styles.tallyDot} aria-hidden="true" />
          <span className={styles.tallyDim}>{occupied} taken</span>
        </div>
      )}
    </div>
  );
}
