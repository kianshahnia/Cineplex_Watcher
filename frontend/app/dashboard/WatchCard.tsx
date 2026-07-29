"use client";

import Link from "next/link";
import { useState } from "react";

import { ExperienceBadges } from "@/app/components/ExperienceBadges";
import { filterExperienceTypes } from "@/lib/experienceTypes";
import { displayTitle, watchShowtimeIso } from "@/lib/watchGrouping";
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

/** Pass an offset-less wall clock — see the note in WatchHeader.tsx. */
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
  const { showtime, status, name, notify_any_seat, seats, created_at } = watch;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Both derivations are imported rather than inlined so this card and the
  // grouping can never drift on what a watch is called or when it screens —
  // the group row's label comes from the very same functions.
  const displayName = displayTitle(watch);
  const theaterName = showtime.theater_name?.trim();
  const showtimeAt = formatShowtime(watchShowtimeIso(watch));
  // Only decides whether the "details unavailable" fallback still applies —
  // the badges component re-applies the suppression rule itself.
  const hasFormats =
    filterExperienceTypes(showtime.experience_types, displayName).length > 0;
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
        <ExperienceBadges
          types={showtime.experience_types}
          title={displayName}
          max={3}
        />
        {!theaterName && !showtimeAt && !hasFormats ? (
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
