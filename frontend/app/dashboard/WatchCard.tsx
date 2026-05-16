"use client";

import Link from "next/link";

import type { Watch } from "@/lib/api";
import styles from "./WatchCard.module.css";

interface Props {
  watch: Watch;
  onCancel: (w: Watch) => void;
  cancelling: boolean;
  /** When >0, renders a "just opened" badge with this count. */
  liveCount?: number;
  /** When true, applies a transient brass-glow border highlight. */
  flashing?: boolean;
  /** Optional connection-status badge rendered in the corner. */
  connectionBadge?: JSX.Element | null;
}

const STATUS_COPY: Record<Watch["status"], { label: string; tone: string }> = {
  active: { label: "Active", tone: "live" },
  fulfilled: { label: "Fulfilled", tone: "good" },
  cancelled: { label: "Cancelled", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
};

function formatShowtime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sortLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function WatchCard({
  watch,
  onCancel,
  cancelling,
  liveCount = 0,
  flashing = false,
  connectionBadge = null,
}: Props): JSX.Element {
  const { showtime, status, notify_any_seat, seats, created_at } = watch;

  const movieName = showtime.movie_name?.trim() || "Your watched showtime";
  const theaterName = showtime.theater_name?.trim();
  const showtimeAt = formatShowtime(showtime.showtime_at);
  const statusInfo = STATUS_COPY[status];

  const seatLabels = sortLabels(seats.map((s) => s.seat_label));
  const notifiedCount = seats.filter((s) => s.notified_at !== null).length;
  const slug = `${showtime.theatre_id}-${showtime.showtime_id}`;

  const isActive = status === "active";

  return (
    <article
      className={`${styles.card} ${isActive ? styles.cardActive : ""} ${flashing ? styles.cardFlash : ""}`}
      data-status={status}
    >
      {liveCount > 0 ? (
        <span className={styles.liveBadge} aria-live="polite">
          <span className={styles.liveBadgeDot} aria-hidden="true" />
          {liveCount === 1
            ? "1 seat just opened"
            : `${liveCount} seats just opened`}
        </span>
      ) : null}

      <div className={styles.topRow}>
        <span
          className={`${styles.statusPill} ${styles[`status_${statusInfo.tone}`]}`}
        >
          <span className={styles.statusDot} aria-hidden="true" />
          {statusInfo.label}
        </span>
        <div className={styles.topRowRight}>
          {connectionBadge}
          <span className={styles.idRef}>
            T{showtime.theatre_id} · S{showtime.showtime_id}
          </span>
        </div>
      </div>

      <h2 className={styles.title}>{movieName}</h2>

      <div className={styles.metaRow}>
        {theaterName ? (
          <span className={styles.metaItem}>{theaterName}</span>
        ) : null}
        {theaterName && showtimeAt ? (
          <span className={styles.metaSep} aria-hidden="true" />
        ) : null}
        {showtimeAt ? (
          <span className={styles.metaItem}>{showtimeAt}</span>
        ) : null}
        {!theaterName && !showtimeAt ? (
          <span className={`${styles.metaItem} ${styles.metaDim}`}>
            Showtime details unavailable
          </span>
        ) : null}
      </div>

      <div className={styles.body}>
        {notify_any_seat ? (
          <div className={styles.anySeat}>
            <span className={styles.anySeatTag}>Any seat</span>
            <span className={styles.anySeatBody}>
              You'll be pinged the moment any seat in the house opens up.
            </span>
          </div>
        ) : null}

        {seatLabels.length > 0 ? (
          <div className={styles.seatsBlock}>
            <div className={styles.seatsHead}>
              <span className={styles.smallLabel}>
                {seatLabels.length === 1
                  ? "1 seat watched"
                  : `${seatLabels.length} seats watched`}
              </span>
              {notifiedCount > 0 ? (
                <span className={styles.notifiedTag}>
                  {notifiedCount} notified
                </span>
              ) : null}
            </div>
            <ul className={styles.chipList}>
              {seatLabels.slice(0, 14).map((label) => (
                <li key={label} className={styles.chip}>
                  {label}
                </li>
              ))}
              {seatLabels.length > 14 ? (
                <li className={`${styles.chip} ${styles.chipMore}`}>
                  +{seatLabels.length - 14}
                </li>
              ) : null}
            </ul>
          </div>
        ) : !notify_any_seat ? (
          <p className={styles.empty}>
            No specific seats picked. Open the seat map to add some.
          </p>
        ) : null}
      </div>

      <footer className={styles.foot}>
        <span className={styles.created}>
          Created {formatRelative(created_at)}
        </span>

        <div className={styles.actions}>
          <Link href={`/watch/${slug}`} className={styles.viewBtn}>
            <span>{isActive ? "Open seat map" : "View seat map"}</span>
            <span className={styles.arrow} aria-hidden="true">→</span>
          </Link>
          {isActive ? (
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => onCancel(watch)}
              disabled={cancelling}
              aria-busy={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}
