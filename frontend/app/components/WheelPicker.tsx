"use client";

import { useCallback, useEffect, useRef } from "react";

import styles from "./WheelPicker.module.css";

export interface WheelItem {
  /** Stable value (not displayed). */
  value: string;
  /** What the user sees on the drum. */
  label: string;
}

interface Props {
  items: WheelItem[];
  /** Controlled selected index. */
  index: number;
  onChange: (index: number) => void;
  ariaLabel: string;
}

// One drum row. The viewport shows exactly three rows (the selection plus one
// above and one below), so the picker reads like an iOS wheel rather than a
// full dropdown list. Keep these in sync with WheelPicker.module.css.
const ITEM_HEIGHT = 36;
const VISIBLE_ROWS = 3;

/**
 * A single iOS-style "drum" column.
 *
 * Scrolling is delegated to the browser's native overflow scroll — that gives
 * us free momentum on touch and mouse-wheel support on desktop. On top of that
 * we add:
 *   - JS snap-to-nearest after the scroll settles (no CSS scroll-snap, which
 *     fights manual scrollTop writes),
 *   - mouse / pen drag (native overflow scroll only drags on touch),
 *   - click-a-row-to-center and arrow-key support,
 *   - a per-row 3D transform (rotateX + scale + fade) painted on every scroll
 *     frame so the rows curve away like a physical drum.
 *
 * The component is controlled: the parent owns `index`. We only call `onChange`
 * once the wheel settles on a new row, so a roll doesn't spam the parent with
 * intermediate values.
 */
export function WheelPicker({ items, index, onChange, ariaLabel }: Props): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pointer-drag bookkeeping (mouse / pen only — touch uses native scroll).
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollRef = useRef(0);
  const dragMovedRef = useRef(false);

  // Latest committed index, read inside imperative handlers without re-binding.
  const indexRef = useRef(index);
  indexRef.current = index;
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;

  // Paint the 3D drum transform for the current scroll position. Done via
  // direct DOM writes (not React state) so it stays smooth during a fast roll.
  const paint = useCallback((): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const center = el.scrollTop / ITEM_HEIGHT; // fractional index at viewport centre
    for (let i = 0; i < itemRefs.current.length; i++) {
      const node = itemRefs.current[i];
      if (!node) continue;
      const offset = i - center;
      const abs = Math.abs(offset);
      const rot = Math.max(-70, Math.min(70, offset * -24));
      const opacity = Math.max(0, 1 - abs * 0.42);
      const scale = Math.max(0.72, 1 - abs * 0.1);
      node.style.transform = `rotateX(${rot}deg) scale(${scale})`;
      node.style.opacity = String(opacity);
    }
  }, []);

  const scrollToIndex = useCallback((i: number, smooth: boolean): void => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: i * ITEM_HEIGHT, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // After scrolling stops, snap to the nearest row and report it upward.
  const settle = useCallback((): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const count = itemCountRef.current;
    if (count === 0) return;
    const nearest = Math.max(0, Math.min(count - 1, Math.round(el.scrollTop / ITEM_HEIGHT)));
    const aligned = Math.abs(el.scrollTop - nearest * ITEM_HEIGHT) < 0.5;
    if (!aligned) {
      // Glide to the snap point; the resulting scroll events re-run settle,
      // which will find us aligned and stop.
      scrollToIndex(nearest, true);
    }
    if (nearest !== indexRef.current) {
      onChange(nearest);
    }
  }, [onChange, scrollToIndex]);

  const scheduleSettle = useCallback((): void => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, 110);
  }, [settle]);

  const onScroll = useCallback((): void => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        paint();
      });
    }
    // While the user is actively mouse-dragging we snap on pointer-up instead.
    if (!draggingRef.current) scheduleSettle();
  }, [paint, scheduleSettle]);

  // --- mouse / pen drag (native overflow scroll only drags on touch) -------
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "touch") return; // let native scrolling handle touch
    const el = scrollerRef.current;
    if (!el) return;
    draggingRef.current = true;
    dragMovedRef.current = false;
    dragStartYRef.current = e.clientY;
    dragStartScrollRef.current = el.scrollTop;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; ignore.
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const dy = e.clientY - dragStartYRef.current;
    if (Math.abs(dy) > 3) dragMovedRef.current = true;
    el.scrollTop = dragStartScrollRef.current - dy;
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const el = scrollerRef.current;
    try {
      el?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    scheduleSettle();
  }, [scheduleSettle]);

  const onItemClick = useCallback((i: number): void => {
    // Suppress the click that fires at the end of a drag gesture.
    if (dragMovedRef.current) return;
    scrollToIndex(i, true);
  }, [scrollToIndex]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const count = itemCountRef.current;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? -1 : 1;
      const next = Math.max(0, Math.min(count - 1, indexRef.current + delta));
      scrollToIndex(next, true);
    }
  }, [scrollToIndex]);

  // Sync scroll position to the controlled `index` when it changes from the
  // outside (initial mount, parent clamp, a sibling wheel shrinking our range).
  // We skip when we're already centred there, so our own onChange → re-render
  // doesn't trigger a redundant (jumpy) re-scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const current = Math.round(el.scrollTop / ITEM_HEIGHT);
    if (current !== index) {
      el.scrollTop = index * ITEM_HEIGHT;
    }
    paint();
  }, [index, items.length, paint]);

  // Cleanup timers / frames on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, []);

  return (
    <div
      className={styles.wheel}
      style={{ height: ITEM_HEIGHT * VISIBLE_ROWS }}
    >
      <div className={styles.band} aria-hidden="true" style={{ top: ITEM_HEIGHT, height: ITEM_HEIGHT }} />
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="listbox"
        aria-label={ariaLabel}
        tabIndex={0}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: ITEM_HEIGHT }} aria-hidden="true" />
        {items.map((item, i) => (
          <div
            key={item.value}
            ref={(node) => {
              itemRefs.current[i] = node;
            }}
            className={styles.item}
            style={{ height: ITEM_HEIGHT }}
            role="option"
            aria-selected={i === index}
            onClick={() => onItemClick(i)}
          >
            {item.label}
          </div>
        ))}
        <div style={{ height: ITEM_HEIGHT }} aria-hidden="true" />
      </div>
    </div>
  );
}
