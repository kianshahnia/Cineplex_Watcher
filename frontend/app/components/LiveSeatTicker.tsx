"use client";

import { useEffect, useState } from "react";

import styles from "./LiveSeatTicker.module.css";

export interface TickerItem {
  /** Stable key — use the seat key + detected_at to dedupe re-renders. */
  id: string;
  seatLabel: string;
  detectedAt: number; // epoch ms
}

interface Props {
  items: TickerItem[];
  /** Max items to show at once. Older ones drop off the bottom. Defaults to 4. */
  max?: number;
  /** Age in ms after which an item fades and is removed. Defaults to 30s. */
  ttlMs?: number;
}

function formatAge(ageMs: number): string {
  if (ageMs < 2000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  const m = Math.floor(ageMs / 60_000);
  return `${m}m ago`;
}

export function LiveSeatTicker({
  items,
  max = 4,
  ttlMs = 30_000,
}: Props): JSX.Element | null {
  // Re-render every second so the "Xs ago" labels stay fresh and items
  // auto-disappear past the TTL.
  const [, force] = useState<number>(0);
  useEffect(() => {
    if (items.length === 0) return;
    const handle = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(handle);
  }, [items.length]);

  const now = Date.now();
  const visible = items
    .filter((it) => now - it.detectedAt < ttlMs)
    .slice(-max)
    .reverse();

  if (visible.length === 0) return null;

  return (
    <ol className={styles.ticker} aria-live="polite" aria-label="Seat updates">
      {visible.map((it) => {
        const age = now - it.detectedAt;
        const fading = age > ttlMs - 4000;
        return (
          <li
            key={it.id}
            className={`${styles.item} ${fading ? styles.fading : ""}`}
          >
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.body}>
              <span className={styles.label}>
                Seat <strong>{it.seatLabel}</strong> opened
              </span>
              <span className={styles.age}>{formatAge(age)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
