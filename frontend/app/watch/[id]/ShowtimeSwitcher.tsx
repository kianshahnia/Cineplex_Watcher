"use client";

/**
 * ShowtimeSwitcher — the row of time buttons above the seat map.
 *
 * Modelled on Cineplex's own Seat Preview modal: the same film, on the same
 * screen, on the same day. Clicking a time **swaps the seat map** to that
 * showtime's live availability; it deliberately does not navigate, because
 * selections across several showtimes only make sense within one page instance
 * and a route change would blow the working set away on every click.
 *
 * Two modes share this row:
 *
 * - **Per showtime** (default) — chips are tabs. One is being viewed; each keeps
 *   its own picks, surfaced as a `·N` badge so nothing hides behind the tab you
 *   happen to be on.
 * - **Same seats for all** — chips become tick boxes. Every pick lands on every
 *   ticked showtime at once, so the per-chip count would say the same number
 *   four times and is dropped.
 *
 * Purely presentational and fully controlled — the parent owns the mode, which
 * showtime is being viewed, what is ticked, what is picked where, and the lazy
 * seat-data cache.
 */

import { useState } from "react";

import type { SelectionMode } from "@/lib/watchSelection";
import styles from "./ShowtimeSwitcher.module.css";

export interface SwitcherOption {
  showtime_id: number;
  /** Naive theatre-local wall clock (`YYYY-MM-DDTHH:MM:SS`), or null. */
  showtime_local: string | null;
  /** The showtime whose link the user pasted — the page's identity. */
  isAnchor: boolean;
  /** Seats picked here but not yet committed. Drives the `·N` badge. */
  picked: number;
  /** True when the user already has an active watch on this showtime. */
  watching: boolean;
  isSoldOut: boolean;
}

interface Props {
  auditorium: string | null;
  /** The set's shared day, taken from the anchor's local start. */
  dayLabel: string | null;
  options: SwitcherOption[];
  mode: SelectionMode;
  onModeChange: (mode: SelectionMode) => void;
  /** Per-showtime mode: the tab being viewed. */
  viewing: number;
  onView: (showtimeId: number) => void;
  /** Grouped mode: the showtimes every pick applies to. */
  ticked: ReadonlySet<number>;
  onToggleTicked: (showtimeId: number) => void;
  /** Showtimes whose seat data is currently being fetched. */
  loadingIds: ReadonlySet<number>;
  /** Showtimes whose seat data failed to load. */
  errorIds: ReadonlySet<number>;
  /** One-line confirmation after a normalize-on-toggle, if any. */
  notice: string | null;
}

/**
 * Time-of-day from an *offset-less* local timestamp. `new Date()` parses it as
 * local, so a Vancouver screening reads "3:00 PM" no matter where the viewer is
 * — the same reasoning as `WatchHeader.formatShowtime`.
 */
export function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function ShowtimeSwitcher({
  auditorium,
  dayLabel,
  options,
  mode,
  onModeChange,
  viewing,
  onView,
  ticked,
  onToggleTicked,
  loadingIds,
  errorIds,
  notice,
}: Props): JSX.Element | null {
  const [infoOpen, setInfoOpen] = useState(false);

  // One showing means no switcher at all — the page looks exactly as it did
  // before this feature existed. That is the common case for limited releases
  // and must not regress into an empty row of chrome.
  if (options.length < 2) return null;

  const grouped = mode === "grouped";
  const tickedCount = options.filter((o) => ticked.has(o.showtime_id)).length;

  return (
    <section className={styles.wrap} aria-label="Other showings">
      <div className={styles.head}>
        <span className={styles.kicker}>Other times</span>
        <span className={styles.rule} aria-hidden="true" />
        {(auditorium || dayLabel) && (
          <span className={styles.context}>
            {[auditorium, dayLabel].filter(Boolean).join(" · ")}
          </span>
        )}

        <div
          className={styles.modeSwitch}
          role="group"
          aria-label="How your picks apply"
        >
          <button
            type="button"
            className={`${styles.modeBtn} ${!grouped ? styles.modeBtnOn : ""}`}
            onClick={() => onModeChange("per-showtime")}
            aria-pressed={!grouped}
          >
            Per showtime
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${grouped ? styles.modeBtnOn : ""}`}
            onClick={() => onModeChange("grouped")}
            aria-pressed={grouped}
          >
            Same for all
          </button>
        </div>

        {/* Disclosure, not permanent copy: there when you're confused about the
            missing colours, invisible when you're not. */}
        <button
          type="button"
          className={styles.infoBtn}
          onClick={() => setInfoOpen((v) => !v)}
          aria-expanded={infoOpen}
          aria-label="How these two modes differ"
        >
          ?
        </button>
      </div>

      {infoOpen ? (
        <div className={styles.info}>
          <p className={styles.infoP}>
            <strong className={styles.infoTerm}>Per showtime</strong> — each time
            keeps its own picks, and the map shows that time&rsquo;s live
            availability.
          </p>
          <p className={styles.infoP}>
            <strong className={styles.infoTerm}>Same for all</strong> — one set
            of seats, applied to every ticked time. The map drops its
            available/occupied colours here on purpose: availability genuinely
            differs between showtimes, so any colour would be wrong for at least
            one of them. The only thing marked is a{" "}
            <span className={styles.infoMark} aria-hidden="true" /> dot on seats
            that are <em className={styles.infoEm}>already free</em> at one of
            the ticked times — hover a seat to see which.
          </p>
        </div>
      ) : null}

      <ul className={styles.chips}>
        {options.map((opt) => {
          const time = formatTime(opt.showtime_local) ?? `#${opt.showtime_id}`;
          const isTicked = ticked.has(opt.showtime_id);
          const isViewing = !grouped && opt.showtime_id === viewing;
          const isLoading = loadingIds.has(opt.showtime_id);
          const isError = errorIds.has(opt.showtime_id);
          const active = grouped ? isTicked : isViewing;

          const label = grouped
            ? `${time}${isTicked ? ", included" : ", not included"}${
                opt.watching ? ", already watching" : ""
              }${opt.isSoldOut ? ", sold out" : ""}`
            : `${time}${opt.isAnchor ? " (the time you pasted)" : ""}${
                opt.picked > 0 ? `, ${opt.picked} seats picked` : ""
              }${opt.watching ? ", already watching" : ""}${
                opt.isSoldOut ? ", sold out" : ""
              }`;

          return (
            <li key={opt.showtime_id}>
              <button
                type="button"
                className={[
                  styles.chip,
                  active ? styles.chipActive : "",
                  !grouped && opt.picked > 0 ? styles.chipPicked : "",
                  grouped && isTicked ? styles.chipPicked : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() =>
                  grouped
                    ? onToggleTicked(opt.showtime_id)
                    : onView(opt.showtime_id)
                }
                role={grouped ? "checkbox" : undefined}
                aria-checked={grouped ? isTicked : undefined}
                aria-current={isViewing ? "true" : undefined}
                aria-label={label}
              >
                {grouped ? (
                  <span className={styles.tick} aria-hidden="true">
                    {isTicked ? "✓" : ""}
                  </span>
                ) : null}

                <span className={styles.time}>{time}</span>

                {opt.watching ? (
                  <span className={styles.watchDot} aria-hidden="true" />
                ) : null}

                {/* Grouped mode applies the same set everywhere, so a per-chip
                    count would print the same number on every chip. */}
                {!grouped && opt.picked > 0 ? (
                  <span className={styles.count} aria-hidden="true">
                    ·{opt.picked}
                  </span>
                ) : null}

                {isLoading ? (
                  <span className={styles.spinner} aria-hidden="true" />
                ) : isError ? (
                  <span
                    className={styles.warn}
                    title="Couldn't load this showtime's seats"
                  >
                    !
                  </span>
                ) : null}

                {/* Sold out is an *incentive* here, not a disabled state — a
                    full house is the best thing to watch. Kept quiet and
                    non-blocking on purpose. */}
                {opt.isSoldOut ? (
                  <span className={styles.soldOut}>Sold out</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      <p className={styles.hint}>
        {grouped
          ? tickedCount === 0
            ? "Tick the times you’d take — your picks apply to all of them."
            : `Every seat you pick applies to all ${tickedCount} ticked times.`
          : "Pick seats at each time you’d take. One tap saves them all."}
      </p>
    </section>
  );
}
