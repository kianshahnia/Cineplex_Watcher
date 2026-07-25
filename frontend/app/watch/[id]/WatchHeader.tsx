"use client";

import { useRef, useState } from "react";

import type { ShowtimeWithSeats } from "@/lib/api";
import styles from "./WatchHeader.module.css";

/**
 * Renders a showtime string. Feed this the *offset-less* `showtime_local`:
 * `new Date("2026-07-25T11:00:00")` is parsed as local time, so the theatre's
 * own wall clock survives regardless of where the viewer is. Passing the
 * aware-UTC `showtime_at` instead would shift the time per viewer timezone.
 */
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

interface Props {
  data: ShowtimeWithSeats;
  /**
   * The signed-in user's personal label for this watch. Wins over the
   * Cineplex-resolved `movie_name`; null means "no override, show the movie".
   */
  name: string | null;
  /**
   * The user's own per-watch date, if they set one before the picker was
   * retired. Wins over the resolved metadata, same precedence as `name`.
   */
  watchShowtimeAt: string | null;
  /**
   * Commits a new label. Resolve to close the editor, **reject to keep it
   * open** so the user can retry (same contract as `WatchCard.onRename`).
   * Null disables editing entirely — signed-out visitors have nowhere to
   * store a name.
   */
  onRename: ((name: string | null) => Promise<void>) | null;
  renaming: boolean;
}

export function WatchHeader({
  data,
  name,
  watchShowtimeAt,
  onRename,
  renaming,
}: Props): JSX.Element {
  const { showtime, is_sold_out, is_post_showtime } = data;

  // Auto-resolved from Cineplex on first view; empty only when the metadata
  // endpoint couldn't resolve this showtime.
  const resolvedTitle = showtime.movie_name?.trim() ?? "";
  const committedName = name?.trim() ?? "";
  const displayName = committedName || resolvedTitle || "Your watched showtime";
  const theaterName = showtime.theater_name?.trim();
  const showtimeAt = formatShowtime(
    watchShowtimeAt ?? showtime.showtime_local ?? showtime.showtime_at,
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Blur commits the edit — except when we're closing the editor ourselves
  // (Enter / Escape), where the trailing blur would double-fire.
  const skipBlurRef = useRef(false);

  const canEdit = onRename !== null;

  function startEditing(): void {
    if (!canEdit || renaming) return;
    skipBlurRef.current = false;
    setDraft(committedName);
    setEditing(true);
  }

  async function commit(): Promise<void> {
    if (!onRename) return;
    const next = draft.trim() || null;
    // Nothing changed — close without a round-trip.
    if ((next ?? "") === committedName) {
      setEditing(false);
      return;
    }
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      // Keep the editor open; WatchInteractive surfaces the error message.
    }
  }

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

      {editing ? (
        <div className={styles.titleEdit}>
          <input
            className={styles.titleInput}
            value={draft}
            maxLength={120}
            autoFocus
            disabled={renaming}
            aria-label="Name this showtime"
            placeholder={resolvedTitle || "Name this showtime"}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipBlurRef.current = true;
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                skipBlurRef.current = true;
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false;
                return;
              }
              void commit();
            }}
          />
          <span className={styles.editHint}>
            {renaming
              ? "Saving…"
              : "Enter to save · Esc to cancel · blank restores the movie title"}
          </span>
        </div>
      ) : canEdit ? (
        <h1 className={styles.title}>
          <button
            type="button"
            className={styles.titleBtn}
            onClick={startEditing}
            title="Click to rename this showtime"
          >
            <span className={styles.titleText}>{displayName}</span>
            <span className={styles.titleEditTag} aria-hidden="true">
              Edit
            </span>
          </button>
        </h1>
      ) : (
        <h1 className={styles.title}>{displayName}</h1>
      )}

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
