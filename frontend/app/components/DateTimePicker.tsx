"use client";

import { useEffect, useRef, useState } from "react";

import { WheelPicker, type WheelItem } from "./WheelPicker";
import styles from "./DateTimePicker.module.css";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// 5-minute granularity keeps the minute drum short while covering real
// showtimes (which are virtually always on a :00/:05/.../:55 boundary).
const MINUTE_STEP = 5;
const MINUTES: number[] = Array.from(
  { length: 60 / MINUTE_STEP },
  (_, i) => i * MINUTE_STEP,
);

const AMPM = ["AM", "PM"];

interface WheelState {
  monthIndex: number; // 0-11
  dayIndex: number; // 0-based (day = dayIndex + 1)
  hourIndex: number; // 0-11 (hour12 = hourIndex + 1)
  minuteIndex: number; // index into MINUTES
  ampmIndex: number; // 0 = AM, 1 = PM
}

interface Props {
  /** Naive ISO (`YYYY-MM-DDTHH:MM:SS`) to seed the wheels, or null for a default. */
  initialValue: string | null;
  /** Fires with a naive ISO string whenever the selection settles. */
  onChange: (isoNaive: string) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(month0: number, year: number): number {
  // Day 0 of the *next* month is the last day of this one.
  return new Date(year, month0 + 1, 0).getDate();
}

function defaultDate(): Date {
  const now = new Date();
  // A sensible showtime default: today at 7:00 PM.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 0);
}

function parseInitial(value: string | null): WheelState {
  let d = defaultDate();
  if (value) {
    // Parse the naive parts directly — don't lean on `new Date(str)`, whose
    // handling of offset-less ISO strings varies across engines.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (m) {
      d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
      );
    }
  }
  const h24 = d.getHours();
  const isPM = h24 >= 12;
  const hour12 = ((h24 + 11) % 12) + 1; // 0→12, 13→1, ...
  // Snap the seeded minute onto the nearest 5-min slot.
  const minuteIndex = Math.round(d.getMinutes() / MINUTE_STEP) % MINUTES.length;
  return {
    monthIndex: d.getMonth(),
    dayIndex: d.getDate() - 1,
    hourIndex: hour12 - 1,
    minuteIndex,
    ampmIndex: isPM ? 1 : 0,
  };
}

/** Resolve the wheel state into a concrete year/day, inferring the year. */
function resolve(state: WheelState): {
  year: number;
  month0: number;
  day: number;
  hour24: number;
  minute: number;
} {
  const refYear = new Date().getFullYear();
  const month0 = state.monthIndex;
  const dim = daysInMonth(month0, refYear);
  const day = Math.min(state.dayIndex, dim - 1) + 1;
  const hour12 = state.hourIndex + 1;
  const minute = MINUTES[state.minuteIndex] ?? 0;
  const isPM = state.ampmIndex === 1;
  const hour24 = isPM
    ? hour12 === 12
      ? 12
      : hour12 + 12
    : hour12 === 12
      ? 0
      : hour12;

  // Infer the year: the *next* occurrence of this month/day. If the picked
  // calendar date is before today, it must mean next year (e.g. picking Jan
  // in December). Compared date-only so a showtime later today stays this year.
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const candMid = new Date(refYear, month0, day);
  const year = candMid.getTime() < todayMid.getTime() ? refYear + 1 : refYear;

  return { year, month0, day, hour24, minute };
}

function toNaiveIso(state: WheelState): string {
  const { year, month0, day, hour24, minute } = resolve(state);
  return `${year}-${pad(month0 + 1)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:00`;
}

export function DateTimePicker({ initialValue, onChange }: Props): JSX.Element {
  const [state, setState] = useState<WheelState>(() => parseInitial(initialValue));

  // Keep the latest onChange without making it a useEffect dependency (the
  // parent typically passes a fresh closure each render).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Emit a naive ISO whenever the selection settles (including on mount, so the
  // parent immediately learns the default/seeded value).
  useEffect(() => {
    onChangeRef.current(toNaiveIso(state));
  }, [state]);

  const refYear = new Date().getFullYear();
  const dim = daysInMonth(state.monthIndex, refYear);
  const dayIndex = Math.min(state.dayIndex, dim - 1);

  const monthItems: WheelItem[] = MONTHS_SHORT.map((label, i) => ({
    value: String(i),
    label,
  }));
  const dayItems: WheelItem[] = Array.from({ length: dim }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
  const hourItems: WheelItem[] = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
  const minuteItems: WheelItem[] = MINUTES.map((mm) => ({
    value: String(mm),
    label: pad(mm),
  }));
  const ampmItems: WheelItem[] = AMPM.map((a, i) => ({ value: String(i), label: a }));

  const setMonth = (i: number): void =>
    setState((s) => {
      const newDim = daysInMonth(i, refYear);
      return { ...s, monthIndex: i, dayIndex: Math.min(s.dayIndex, newDim - 1) };
    });
  const setDay = (i: number): void => setState((s) => ({ ...s, dayIndex: i }));
  const setHour = (i: number): void => setState((s) => ({ ...s, hourIndex: i }));
  const setMinute = (i: number): void => setState((s) => ({ ...s, minuteIndex: i }));
  const setAmpm = (i: number): void => setState((s) => ({ ...s, ampmIndex: i }));

  // Human-readable preview of the resolved value.
  const r = resolve(state);
  const previewDate = new Date(r.year, r.month0, r.day, r.hour24, r.minute);
  const previewDay = previewDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const previewTime = previewDate.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.preview}>
        <span className={styles.previewDay}>{previewDay}</span>
        <span className={styles.previewSep} aria-hidden="true">·</span>
        <span className={styles.previewTime}>{previewTime}</span>
        {r.year !== refYear ? (
          <span className={styles.previewYear}>{r.year}</span>
        ) : null}
      </div>

      <div className={styles.cols}>
        <Column label="Month" flex={1.5}>
          <WheelPicker
            items={monthItems}
            index={state.monthIndex}
            onChange={setMonth}
            ariaLabel="Month"
          />
        </Column>
        <Column label="Day" flex={1}>
          <WheelPicker
            items={dayItems}
            index={dayIndex}
            onChange={setDay}
            ariaLabel="Day"
          />
        </Column>
        <span className={styles.divider} aria-hidden="true" />
        <Column label="Hour" flex={1}>
          <WheelPicker
            items={hourItems}
            index={state.hourIndex}
            onChange={setHour}
            ariaLabel="Hour"
          />
        </Column>
        <Column label="Min" flex={1}>
          <WheelPicker
            items={minuteItems}
            index={state.minuteIndex}
            onChange={setMinute}
            ariaLabel="Minute"
          />
        </Column>
        <Column label="" flex={0.9}>
          <WheelPicker
            items={ampmItems}
            index={state.ampmIndex}
            onChange={setAmpm}
            ariaLabel="AM or PM"
          />
        </Column>
      </div>
    </div>
  );
}

function Column({
  label,
  flex,
  children,
}: {
  label: string;
  flex: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={styles.col} style={{ flex }}>
      <span className={styles.colLabel}>{label}</span>
      {children}
    </div>
  );
}
