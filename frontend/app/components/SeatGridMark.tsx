/**
 * SeatGridMark — the recurring brand motif.
 *
 * A small abstract auditorium: 5 cols x 3 rows of rounded "seats" with a
 * single brass cell that pulses slowly. Used as the leading element of the
 * wordmark and (at larger sizes, dimmed) as ambient art in the hero.
 */
type Size = "sm" | "md" | "lg";

const SCALE: Record<Size, number> = {
  sm: 1,
  md: 1.6,
  lg: 3,
};

const COLS = 5;
const ROWS = 3;
const SEAT_W = 4;
const SEAT_H = 3;
const GAP = 2.2;
const BRASS_CELL = { col: 3, row: 1 };

export function SeatGridMark({
  size = "sm",
  dim = false,
  label,
}: {
  size?: Size;
  dim?: boolean;
  label?: string;
}): JSX.Element {
  const scale = SCALE[size];
  const w = COLS * SEAT_W + (COLS - 1) * GAP;
  const h = ROWS * SEAT_H + (ROWS - 1) * GAP;

  return (
    <svg
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ flexShrink: 0, opacity: dim ? 0.55 : 1 }}
    >
      {Array.from({ length: ROWS }).map((_, row) =>
        Array.from({ length: COLS }).map((__, col) => {
          const isBrass = col === BRASS_CELL.col && row === BRASS_CELL.row;
          const x = col * (SEAT_W + GAP);
          const y = row * (SEAT_H + GAP);
          return (
            <rect
              key={`${row}-${col}`}
              x={x}
              y={y}
              width={SEAT_W}
              height={SEAT_H}
              rx={0.6}
              fill={isBrass ? "var(--brass)" : "var(--silver-deep)"}
              style={
                isBrass
                  ? {
                      transformOrigin: `${x + SEAT_W / 2}px ${y + SEAT_H / 2}px`,
                      animation: "brassPulse 4.6s ease-in-out infinite",
                    }
                  : undefined
              }
            />
          );
        }),
      )}
    </svg>
  );
}
