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
  /**
   * Permanently delete the watch — the card's only destructive action.
   *
   * Cancel (soft archive) and Remove (hard delete) used to be two buttons; they
   * are one now, labelled "Cancel", and there is no confirmation. See
   * `docs/bugs.md` #8 / #9.
   */
  onDelete: (w: Watch) => void;
  deleting: boolean;
  /** Rename the watch. Resolves on success, rejects so the editor stays open. */
  onRename: (w: Watch, name: string | null) => Promise<void>;
  renaming: boolean;
  /** Edit mode: show the corner checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (w: Watch) => void;
}

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
  onDelete,
  deleting,
  onRename,
  renaming,
  selectable = false,
  selected = false,
  onToggleSelect,
}: Props): JSX.Element {
  const {
    showtime,
    status,
    name,
    notify_any_seat,
    min_adjacent_seats,
    seats,
    created_at,
  } = watch;

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

  const seatLabels = sortLabels(seats.map((s) => s.seat_label));
  const notifiedCount = seats.filter((s) => s.notified_at !== null).length;
  const slug = `${showtime.theatre_id}-${showtime.showtime_id}`;

  const isActive = status === "active";
  const busy = deleting;

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
      className={[
        styles.card,
        isActive ? styles.cardActive : "",
        selectable && selected ? styles.cardSelected : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-status={status}
    >
      {/* The status pill that used to live here is gone (docs/bugs.md #14): with
          two tabs and no `fulfilled`, a card's status is whichever tab you are
          looking at, so the pill only repeated it. What carries the difference
          now is the wash on non-active cards + the brass top edge on active
          ones. The row itself renders only in edit mode — an empty flex box
          would still take the card's 16px gap. */}
      {selectable ? (
        <div className={styles.topRow}>
          <button
            type="button"
            className={`${styles.selectBox} ${selected ? styles.selectBoxOn : ""}`}
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${displayName}`}
            onClick={() => onToggleSelect?.(watch)}
          >
            <span aria-hidden="true">{selected ? "✓" : ""}</span>
          </button>
        </div>
      ) : null}

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
              {/* Grouped, so the row stays "label ......... tags" however many
                  of them there are — `space-between` with three loose children
                  would strand the first one in the middle. */}
              <span className={styles.seatsTags}>
                {/* The alert rule belongs next to the seat count, not in the meta
                    row: it changes what "N seats watched" will actually notify
                    you about, and read on its own up there it would look like
                    another format badge. */}
                {min_adjacent_seats !== null ? (
                  <span
                    className={styles.blockTag}
                    title={`Only alerts when ${min_adjacent_seats} of these seats are free side by side`}
                  >
                    {min_adjacent_seats} in a row
                  </span>
                ) : null}
                {notifiedCount > 0 ? (
                  <span className={styles.notifiedTag}>
                    {notifiedCount} notified
                  </span>
                ) : null}
              </span>
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
          {/* One destructive action, on every card whatever its status. It is
              a permanent delete and it asks nothing first — see the prop
              docs above. */}
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => onDelete(watch)}
            disabled={deleting}
            aria-busy={deleting}
            title="Removes this watch permanently"
          >
            {deleting ? "Removing…" : "Cancel"}
          </button>
        </div>
      </footer>
    </article>
  );
}
