"use client";

import { useId, useState } from "react";
import type { TransitionEvent } from "react";

import type { Watch, WatchStatus } from "@/lib/api";
import type { WatchGroup } from "@/lib/watchGrouping";
import gridStyles from "./Dashboard.module.css";
import styles from "./WatchGroupCard.module.css";

interface Props {
  group: WatchGroup;
  expanded: boolean;
  onToggle: (key: string) => void;
  /**
   * Render prop returning the `<li>` for one watch.
   *
   * Keeps this component ignorant of cancel / remove / rename — `DashboardClient`
   * keeps owning every mutation exactly as it did before grouping, instead of
   * threading six handlers and three busy flags through a presentational row.
   */
  renderWatch: (w: Watch) => JSX.Element;
}

/** Fixed order so a mixed summary always reads the same way. */
const STATUS_ORDER: readonly WatchStatus[] = [
  "active",
  "fulfilled",
  "expired",
  "cancelled",
];

const STATUS_LABEL: Record<WatchStatus, string> = {
  active: "Active",
  fulfilled: "Fulfilled",
  expired: "Expired",
  cancelled: "Cancelled",
};

interface StatusSummary {
  text: string;
  /** The single status every member shares, or null when the group is mixed. */
  uniform: WatchStatus | null;
}

/**
 * One pill when every watch shares a status, "3 active · 1 expired" when the All
 * filter mixes them.
 *
 * A collapsed row stands in for everything inside it, so it must never imply a
 * status the group doesn't uniformly hold.
 */
function statusSummary(counts: Record<WatchStatus, number>): StatusSummary {
  const present = STATUS_ORDER.filter((s) => counts[s] > 0);
  const only = present[0];
  if (present.length === 1 && only !== undefined) {
    return { text: STATUS_LABEL[only], uniform: only };
  }
  return {
    text: present.map((s) => `${counts[s]} ${s}`).join(" · "),
    uniform: null,
  };
}

/** Matches WatchCard's pill tones so a row and the cards inside it agree. */
function toneOf(group: WatchGroup, status: StatusSummary): string {
  if (group.activeCount > 0) return "live";
  if (status.uniform === "fulfilled") return "good";
  return "muted";
}

/**
 * Seats are the one summary a user scans for, so say something even when a group
 * holds only "any seat" watches — which legitimately track zero specific seats.
 */
function seatText(group: WatchGroup): string | null {
  if (group.seatCount > 0) {
    return group.seatCount === 1 ? "1 seat" : `${group.seatCount} seats`;
  }
  return group.watches.some((w) => w.notify_any_seat) ? "Any seat" : null;
}

export function WatchGroupCard({
  group,
  expanded,
  onToggle,
  renderWatch,
}: Props): JSX.Element {
  const id = useId();

  // Whether the cards are in the DOM. It leads `expanded` on the way open and
  // lags it on the way closed, because a height transition needs something to
  // animate in both directions.
  const [mounted, setMounted] = useState(expanded);

  // React's sanctioned "adjust state during render" — the cards have to be laid
  // out on the same frame the open transition starts, and an effect runs a frame
  // too late, which would collapse the animation into a jump.
  if (expanded && !mounted) setMounted(true);

  const count = group.watches.length;
  const status = statusSummary(group.statusCounts);
  const tone = toneOf(group, status);
  const seats = seatText(group);
  // The stacked-paper edge only makes sense when there really is a stack behind
  // the row — and only while it's closed.
  const stacked = !expanded && count > 1;

  // The close animation has finished, so the cards can leave. Guarded on the
  // element and the property because child transitions (a card's own hover,
  // the body's `visibility`) bubble through here too.
  function onBodyTransitionEnd(e: TransitionEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "grid-template-rows") return;
    if (!expanded) setMounted(false);
  }

  return (
    <section
      className={`${styles.group} ${group.activeCount > 0 ? styles.groupActive : ""}`}
      aria-labelledby={`${id}-label`}
    >
      <button
        type="button"
        className={`${styles.row} ${stacked ? styles.rowStacked : ""}`}
        aria-expanded={expanded}
        aria-controls={`${id}-body`}
        onClick={() => onToggle(group.key)}
      >
        <span
          className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
          aria-hidden="true"
        >
          ▸
        </span>

        <span className={styles.head}>
          <span id={`${id}-label`} className={styles.label}>
            {group.label}
          </span>
          <span className={styles.count}>×{count}</span>
        </span>

        <span className={styles.meta}>
          {group.facets.map((f) => (
            <span
              key={f.kind}
              className={`${styles.facet} ${f.uniform ? "" : styles.facetSpan}`}
            >
              {f.text}
            </span>
          ))}
          {seats ? <span className={styles.facet}>{seats}</span> : null}
        </span>

        <span className={styles.tail}>
          {group.notifiedCount > 0 ? (
            <span className={styles.notifiedTag}>
              {group.notifiedCount} notified
            </span>
          ) : null}
          <span
            className={`${styles.statusPill} ${styles[`status_${tone}`]}`}
          >
            {status.text}
          </span>
        </span>
      </button>

      {/*
        Always rendered so `aria-controls` always resolves to a real element.
        The cards inside mount only around an open — a11y correctness and no
        cost for a closed row, minus the frames the animation needs.

        `hidden` is deliberately not used: it means `display: none`, which
        cancels the height transition outright. `.bodyInner`'s `visibility`
        takes it out of the accessibility tree and the tab order instead, after
        the closing animation has run.
      */}
      <div
        id={`${id}-body`}
        className={`${styles.body} ${expanded ? styles.bodyOpen : ""}`}
        onTransitionEnd={onBodyTransitionEnd}
      >
        <div className={styles.bodyInner}>
          {mounted ? (
            <ul className={`${gridStyles.grid} ${styles.bodyGrid}`}>
              {group.watches.map(renderWatch)}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
