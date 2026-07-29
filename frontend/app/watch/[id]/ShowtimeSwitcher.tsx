"use client";

/**
 * ShowtimeSwitcher — the row of time buttons above the seat map.
 *
 * Modelled on Cineplex's own Seat Preview modal: the same film, on the same
 * screen, on the same day. Each chip is a **tick box**: the seats you pick apply
 * to every ticked time at once. The showtime whose link was pasted starts ticked
 * and nothing else does, so a user who only wants that one showing never has to
 * think about this row at all.
 *
 * It deliberately does not navigate — a route change would blow the working set
 * away on every click, and picks across several showtimes only make sense within
 * one page instance.
 *
 * Purely presentational and fully controlled — the parent owns what is ticked,
 * what is picked, and the lazy seat-data cache.
 */

import { useState } from "react";

import styles from "./ShowtimeSwitcher.module.css";

export interface SwitcherOption {
  showtime_id: number;
  /** Naive theatre-local wall clock (`YYYY-MM-DDTHH:MM:SS`), or null. */
  showtime_local: string | null;
  /** The showtime whose link the user pasted — the page's identity. */
  isAnchor: boolean;
  /** True when the user already has an active watch on this showtime. */
  watching: boolean;
  isSoldOut: boolean;
}

interface Props {
  auditorium: string | null;
  /** The set's shared day, taken from the anchor's local start. */
  dayLabel: string | null;
  options: SwitcherOption[];
  /** The showtimes every pick applies to. Never empty. */
  ticked: ReadonlySet<number>;
  onToggleTicked: (showtimeId: number) => void;
  /** Showtimes whose seat data is currently being fetched. */
  loadingIds: ReadonlySet<number>;
  /** Showtimes whose seat data failed to load. */
  errorIds: ReadonlySet<number>;
  /** One-line confirmation after a tick changed the picks, if any. */
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

  const tickedCount = options.filter((o) => ticked.has(o.showtime_id)).length;

  return (
    <section className={styles.wrap} aria-label="Other showings">
      <div className={styles.head}>
        <span className={styles.kicker}>Showtimes</span>
        <span className={styles.rule} aria-hidden="true" />
        {(auditorium || dayLabel) && (
          <span className={styles.context}>
            {[auditorium, dayLabel].filter(Boolean).join(" · ")}
          </span>
        )}

        {/* Disclosure, not permanent copy: there when you're confused about the
            missing colours, invisible when you're not. */}
        <button
          type="button"
          className={styles.infoBtn}
          onClick={() => setInfoOpen((v) => !v)}
          aria-expanded={infoOpen}
          aria-label="How these times work"
        >
          ?
        </button>
      </div>

      {infoOpen ? (
        <div className={styles.info}>
          <p className={styles.infoP}>
            Every seat you pick applies to all the ticked times at once — tick a
            second showing and you&rsquo;re watching the same seats there too.
          </p>
          <p className={styles.infoP}>
            The map doesn&rsquo;t colour seats available or occupied, because
            availability changes the moment someone books and differs between
            showings. The only thing marked is a{" "}
            <span className={styles.infoMark} aria-hidden="true" /> dot on seats
            that are <span className={styles.infoEm}>already free</span>
            {tickedCount > 1 ? (
              <> at one of the ticked times — hover a seat to see which</>
            ) : (
              <> right now</>
            )}
            .
          </p>
        </div>
      ) : null}

      <ul className={styles.chips}>
        {options.map((opt) => {
          const time = formatTime(opt.showtime_local) ?? `#${opt.showtime_id}`;
          const isTicked = ticked.has(opt.showtime_id);
          const isLoading = loadingIds.has(opt.showtime_id);
          const isError = errorIds.has(opt.showtime_id);
          // Something always has to be in play, so the last ticked time can't be
          // unticked. To swap showings, tick the new one first.
          const isLocked = isTicked && tickedCount === 1;

          const label = `${time}${opt.isAnchor ? " (the time you pasted)" : ""}${
            isTicked ? ", included" : ", not included"
          }${isLocked ? " — at least one time has to stay selected" : ""}${
            opt.watching ? ", already watching" : ""
          }${opt.isSoldOut ? ", sold out" : ""}`;

          return (
            <li key={opt.showtime_id}>
              <button
                type="button"
                className={[
                  styles.chip,
                  isTicked ? styles.chipActive : "",
                  isTicked ? styles.chipPicked : "",
                  isLocked ? styles.chipLocked : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  if (!isLocked) onToggleTicked(opt.showtime_id);
                }}
                role="checkbox"
                aria-checked={isTicked}
                aria-disabled={isLocked ? true : undefined}
                aria-label={label}
                title={
                  isLocked ? "At least one time has to stay selected" : undefined
                }
              >
                <span className={styles.tick} aria-hidden="true">
                  {isTicked ? "✓" : ""}
                </span>

                <span className={styles.time}>{time}</span>

                {opt.watching ? (
                  <span className={styles.watchDot} aria-hidden="true" />
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
        {tickedCount === 1
          ? "Tick another time to watch the same seats there too."
          : `Every seat you pick applies to all ${tickedCount} ticked times.`}
      </p>
    </section>
  );
}
