"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Watch } from "@/lib/api";
import { LiveStatusPill } from "../components/LiveStatusPill";
import {
  useShowtimeEvents,
  type ShowtimeEvent,
  type WsStatus,
} from "@/hooks/useShowtimeEvents";
// TEST FIXTURE — detect the preview showtime and run a fake event emitter.
import { isTestShowtimeUuid } from "@/lib/test/buildLayout";
import { WatchCard } from "./WatchCard";

interface Props {
  watch: Watch;
  onCancel: (w: Watch) => void;
  cancelling: boolean;
}

const COUNTER_RESET_MS = 18_000;
const FLASH_MS = 2400;

/**
 * One-per-card wrapper: owns a single WebSocket subscription for the watch's
 * showtime and rolls incoming `seat_available` events into a transient
 * "just opened" counter + flash. Inactive watches skip the subscription.
 */
export function WatchCardLive({
  watch,
  onCancel,
  cancelling,
}: Props): JSX.Element {
  const isActive = watch.status === "active";
  const [liveCount, setLiveCount] = useState<number>(0);
  const [flashing, setFlashing] = useState<boolean>(false);

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEvent = useCallback((event: ShowtimeEvent): void => {
    if (event.type !== "seat_available") return;

    setLiveCount((n) => n + 1);
    setFlashing(true);

    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashing(false), FLASH_MS);

    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setLiveCount(0), COUNTER_RESET_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // TEST FIXTURE — preview watch skips the real WS and uses a slower emitter.
  const isTest = isTestShowtimeUuid(watch.showtime.id);

  const { status: realWsStatus } = useShowtimeEvents({
    showtimeUuid: isActive && !isTest ? watch.showtime.id : null,
    enabled: isActive && !isTest,
    onEvent,
  });

  // TEST FIXTURE — emit one fake event every ~22s so the card flash + the
  // "N just opened" badge are demonstrable on the dashboard preview.
  useEffect(() => {
    if (!isTest || !isActive) return;
    const handle = window.setInterval(() => {
      // The label is just for the (invisible) ticker on the watch page — on
      // the dashboard we only count + flash, so any plausible seat works.
      onEvent({
        type: "seat_available",
        showtime_uuid: watch.showtime.id,
        theatre_id: watch.showtime.theatre_id,
        showtime_id: watch.showtime.showtime_id,
        seat_key: "preview",
        seat_label: "preview",
        detected_at: new Date().toISOString(),
      });
    }, 22_000);
    return () => window.clearInterval(handle);
  }, [
    isTest,
    isActive,
    onEvent,
    watch.showtime.id,
    watch.showtime.theatre_id,
    watch.showtime.showtime_id,
  ]);

  // TEST FIXTURE — show the connection as live during preview sessions.
  const wsStatus: WsStatus = isTest && isActive ? "open" : realWsStatus;

  return (
    <WatchCard
      watch={watch}
      onCancel={onCancel}
      cancelling={cancelling}
      liveCount={liveCount}
      flashing={flashing}
      connectionBadge={
        isActive ? <LiveStatusPill status={wsStatus} liveLabel="Live" /> : null
      }
    />
  );
}
