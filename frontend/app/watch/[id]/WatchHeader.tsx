import type { ShowtimeWithSeats } from "@/lib/api";
import styles from "./WatchHeader.module.css";

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

export function WatchHeader({ data }: { data: ShowtimeWithSeats }): JSX.Element {
  const { showtime, is_sold_out, is_post_showtime } = data;
  const movieName = showtime.movie_name?.trim() || "Your watched showtime";
  const theaterName = showtime.theater_name?.trim();
  const showtimeAt = formatShowtime(showtime.showtime_at);

  let statusLabel: string;
  let statusClass: string | undefined;
  if (is_post_showtime) {
    statusLabel = "Showtime passed";
    statusClass = styles.statusMuted;
  } else if (is_sold_out) {
    statusLabel = "Sold out";
    statusClass = styles.statusWarn;
  } else if (showtime.is_active) {
    statusLabel = "Live";
    statusClass = styles.statusLive;
  } else {
    statusLabel = "Inactive";
    statusClass = styles.statusMuted;
  }

  return (
    <header className={styles.head}>
      <div className={styles.eyebrowRow}>
        <span className={styles.eyebrow}>Now watching</span>
        <span className={`${styles.statusPill} ${statusClass}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <h1 className={styles.title}>{movieName}</h1>

      {(theaterName || showtimeAt) && (
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
        </div>
      )}
    </header>
  );
}
