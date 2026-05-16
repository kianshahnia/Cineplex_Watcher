/**
 * SeatMap — controlled SVG renderer for a Cineplex auditorium.
 *
 * - Step 2: read-only render + colour by availability.
 * - Step 3: when `onSeatToggle` is passed, seats become clickable. The parent
 *   owns selection state (`selectedIds`) and committed-watch state
 *   (`watchedIds`) — this component is purely presentational.
 */
import type { RowDetail, SeatDetail, SeatMapLayout } from "@/lib/api";
import styles from "./SeatMap.module.css";

const CELL_W = 22;
const CELL_H = 18;
const GAP_X = 3;
const GAP_Y = 6;
const LABEL_W = 40;
const SCREEN_H = 92;
const AISLE_H = 10;
const BOTTOM_PAD = 16;

interface RowGeo {
  row: RowDetail;
  y: number;
  height: number;
}

interface SeatMapProps {
  layout: SeatMapLayout;
  selectedIds?: Set<string>;
  watchedIds?: Set<string>;
  /** Seats currently animating their Occupied → Available transition. */
  flashIds?: Set<string>;
  onSeatToggle?: (seat: SeatDetail) => void;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
}

export function SeatMap({
  layout,
  selectedIds,
  watchedIds,
  flashIds,
  onSeatToggle,
}: SeatMapProps): JSX.Element {
  const cols = layout.total_columns;
  const innerW = cols * CELL_W + Math.max(0, cols - 1) * GAP_X;
  const totalW = LABEL_W * 2 + innerW;

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

  return (
    <div className={styles.wrap}>
      <div className={styles.scroller}>
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
            renderRow(row, y, height, totalW, {
              selectedIds,
              watchedIds,
              flashIds,
              onSeatToggle,
            }),
          )}
        </svg>
      </div>
      <SeatLegend
        total={seatCount}
        available={availableCount}
        occupied={seatCount - availableCount}
        showWatched={Boolean(watchedIds && watchedIds.size > 0) || Boolean(onSeatToggle)}
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
  onSeatToggle?: (seat: SeatDetail) => void;
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
        x={LABEL_W - 14}
        y={centerY}
        textAnchor="end"
        dominantBaseline="central"
        className={styles.rowLabel}
      >
        {row.label}
      </text>
      <text
        x={totalW - LABEL_W + 14}
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
          x={LABEL_W + (seat.column - 1) * (CELL_W + GAP_X)}
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
  const isInteractive = Boolean(interact.onSeatToggle) && !isUnknown && !isWatched;

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
      onClick={
        isInteractive && interact.onSeatToggle
          ? () => interact.onSeatToggle!(seat)
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
