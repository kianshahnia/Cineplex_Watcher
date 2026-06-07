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
 * - Touch keeps tap-to-toggle only, so vertical/horizontal scrolling of the map
 *   still works with a finger.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { RowDetail, SeatDetail, SeatMapLayout } from "@/lib/api";
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

interface SeatMapProps {
  layout: SeatMapLayout;
  selectedIds?: Set<string>;
  watchedIds?: Set<string>;
  /** Seats currently animating their Occupied → Available transition. */
  flashIds?: Set<string>;
  /** Set a seat's picked state. Presence of this prop enables selection. */
  onSeatPaint?: (seatId: string, select: boolean) => void;
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
  onSeatPaint,
}: SeatMapProps): JSX.Element {
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
    if (!onSeatPaint || e.pointerType === "touch" || e.button !== 0) return;
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
    // Capture so we keep getting moves even if the pointer leaves the map; the
    // capture target doesn't affect elementFromPoint hit-testing below.
    try {
      scrollerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // capture can throw if the pointer is already gone — ignore
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      drag.started = true;
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
    enabled: Boolean(onSeatPaint),
    onSeatClick: handleSeatClick,
  };

  return (
    <div className={styles.wrap}>
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
          aria-label={`Seat map: ${availableCount} of ${seatCount} seats available across ${layout.rows.filter((r) => r.seats.length > 0).length} rows`}
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
      />
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
  /** Whether selection is enabled (onSeatPaint was provided). */
  enabled?: boolean;
  onSeatClick?: (seat: SeatDetail) => void;
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
  return (
    <g key={row.number}>
      <text
        x={ROW_LABEL_X}
        y={centerY}
        textAnchor="end"
        dominantBaseline="central"
        className={styles.rowLabel}
      >
        {row.label}
      </text>
      <text
        x={totalW - ROW_LABEL_X}
        y={centerY}
        textAnchor="start"
        dominantBaseline="central"
        className={styles.rowLabel}
      >
        {row.label}
      </text>
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

  const isSelected = interact.selectedIds?.has(seat.id) ?? false;
  const isWatched = interact.watchedIds?.has(seat.id) ?? false;
  const isFlashing = interact.flashIds?.has(seat.id) ?? false;
  const isInteractive = Boolean(interact.enabled) && !isUnknown && !isWatched;

  const stateClass = isAvailable
    ? styles.available
    : isOccupied
      ? styles.occupied
      : styles.unknown;

  const className = cx(
    styles.seat,
    stateClass,
    isSpecial && styles.special,
    isSelected && styles.selected,
    isWatched && styles.watched,
    isFlashing && styles.flashing,
    isInteractive && styles.interactive,
  );

  const tooltipParts = [
    seat.label,
    seat.status,
    isFlashing && "just opened",
    isWatched && "already watching",
    isSelected && "selected",
    isSpecial && seat.type,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  const tooltip = tooltipParts.join(" · ");

  return (
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
}

function SeatLegend({
  total,
  available,
  occupied,
  showWatched,
}: {
  total: number;
  available: number;
  occupied: number;
  showWatched: boolean;
}): JSX.Element {
  return (
    <div className={styles.legendRow}>
      <ul className={styles.legend}>
        <li className={styles.legendItem}>
          <span className={`${styles.chip} ${styles.chipAvailable}`} aria-hidden="true" />
          Available
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.chip} ${styles.chipOccupied}`} aria-hidden="true" />
          Occupied
        </li>
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
      <div className={styles.tally}>
        <span className={styles.tallyNumber}>{available}</span>
        <span className={styles.tallySep}>/</span>
        <span className={styles.tallyTotal}>{total}</span>
        <span className={styles.tallyLabel}>seats open</span>
        <span className={styles.tallyDot} aria-hidden="true" />
        <span className={styles.tallyDim}>{occupied} taken</span>
      </div>
    </div>
  );
}
