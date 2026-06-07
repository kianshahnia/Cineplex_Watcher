"use client";

import Link from "next/link";
import { useState } from "react";

import type { Watch } from "@/lib/api";
import styles from "./WatchCard.module.css";

interface Props {
  watch: Watch;
  onCancel: (w: Watch) => void;
  cancelling: boolean;
  /** Permanently delete the watch (hard delete, any status). */
  onRemove: (w: Watch) => void;
  removing: boolean;
  /** Rename the watch. Resolves on success, rejects so the editor stays open. */
  onRename: (w: Watch, name: string | null) => Promise<void>;
  renaming: boolean;
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
  onRemove,
  removing,
  onRename,
  renaming,
}: Props): JSX.Element {
  const { showtime, status, name, showtime_at, notify_any_seat, seats, created_at } =
    watch;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // The watch's own name wins; otherwise fall back to the (currently always
  // NULL) movie name, then a generic placeholder.
  const displayName =
    name?.trim() || showtime.movie_name?.trim() || "Your watched showtime";
  const theaterName = showtime.theater_name?.trim();
  // The user's per-watch date wins over the (always-NULL) shared showtime
  // metadata — same precedence as the name.
  const showtimeAt = formatShowtime(showtime_at ?? showtime.showtime_at);
  const statusInfo = STATUS_COPY[status];

  const seatLabels = sortLabels(seats.map((s) => s.seat_label));
  const notifiedCount = seats.filter((s) => s.notified_at !== null).length;
  const slug = `${showtime.theatre_id}-${showtime.showtime_id}`;

  const isActive = status === "active";
  const busy = cancelling || removing;

  function startEditing(): void {
    setDraft(name ?? "");
    setEditing(true);
  }

  async function saveName(): Promise<void> {
    if (renaming) return;
    try {
      await onRename(watch, draft.trim() || null);
      setEditing(false);
    } catch {
      // Keep the editor open; the dashboard surfaces the error banner.
    }
  }

  return (
    <article
      className={`${styles.card} ${isActive ? styles.cardActive : ""}`}
      data-status={status}
    >
      <div className={styles.topRow}>
        <span
          className={`${styles.statusPill} ${styles[`status_${statusInfo.tone}`]}`}
        >
          <span className={styles.statusDot} aria-hidden="true" />
          {statusInfo.label}
        </span>
      </div>

      {editing ? (
        <div className={styles.renameRow}>
          <input
            className={styles.renameInput}
            value={draft}
            maxLength={120}
            autoFocus
            placeholder="Name this showtime"
            disabled={renaming}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveName();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button
            type="button"
            className={styles.renameSave}
            onClick={() => void saveName()}
            disabled={renaming}
            aria-busy={renaming}
          >
            {renaming ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className={styles.renameCancel}
            onClick={() => setEditing(false)}
            disabled={renaming}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{displayName}</h2>
          <button
            type="button"
            className={styles.renameBtn}
            onClick={startEditing}
            disabled={busy}
            title="Rename this watch"
          >
            Rename
          </button>
        </div>
      )}

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
              You’ll be pinged the moment any seat in the house opens up.
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
            <span className={styles.viewBtnFull}>{isActive ? "Open seat map" : "View seat map"}</span>
            <span className={styles.viewBtnShort}>Seat map</span>
            <span className={styles.arrow} aria-hidden="true">→</span>
          </Link>
          {isActive ? (
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => onCancel(watch)}
              disabled={cancelling || removing}
              aria-busy={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.removeBtn}
            onClick={() => onRemove(watch)}
            disabled={removing || cancelling}
            aria-busy={removing}
            title="Remove this watch permanently"
          >
            {removing ? "Removing…" : "Remove"}
          </button>
        </div>
      </footer>
    </article>
  );
}
