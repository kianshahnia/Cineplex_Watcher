"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Real-time WebSocket hook for a single showtime channel.
 *
 * Connects to `ws://<backend>/ws/<showtime_uuid>`, parses server messages,
 * and exposes:
 *   - `status`: current connection state for UI badges.
 *   - `lastEvent`: the most recent `seat_available` event (component-driven
 *     side-effects subscribe via the `onEvent` callback below).
 *
 * Reconnection: capped exponential backoff (1s → 2s → 4s → 8s, cap 15s).
 * Hard-close codes (4001/4003 from the backend) skip reconnection — they
 * mean "you're not signed in" or "this showtime is over", and retrying won't
 * help.  All other closes reconnect indefinitely.
 *
 * The hook never throws.  Failures move the status to "error" and trigger
 * the reconnect timer.
 */

export interface SeatAvailableEvent {
  type: "seat_available";
  showtime_uuid: string;
  theatre_id: number;
  showtime_id: number;
  seat_key: string;
  seat_label: string;
  detected_at: string;
}

export interface ConnectedEvent {
  type: "connected";
  showtime_uuid: string;
}

export type ShowtimeEvent = SeatAvailableEvent | ConnectedEvent;

export type WsStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

interface Options {
  /**
   * The internal showtime UUID (the PK from the `showtimes` table).
   * Pass `null` to keep the hook disabled — useful while the showtime is
   * still loading or for paused dashboards.
   */
  showtimeUuid: string | null;
  /** Whether to actively maintain a connection. Defaults to true. */
  enabled?: boolean;
  /**
   * Called once per parsed event.  Use this for side-effects (state
   * updates, toasts).  Do NOT rely on `lastEvent` for accumulation —
   * fast bursts may collapse identical references in React's render cycle.
   */
  onEvent?: (event: ShowtimeEvent) => void;
}

interface Result {
  status: WsStatus;
  lastEvent: ShowtimeEvent | null;
  attempts: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 15_000;

// Backend close codes that should NOT trigger reconnect.
// 4001 = not authenticated, 4003 = showtime not found/inactive.
const TERMINAL_CLOSE_CODES = new Set([4001, 4003]);

function wsBaseUrl(): string {
  const httpBase =
    process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
  return httpBase.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`);
}

export function useShowtimeEvents({
  showtimeUuid,
  enabled = true,
  onEvent,
}: Options): Result {
  const [status, setStatus] = useState<WsStatus>("idle");
  const [lastEvent, setLastEvent] = useState<ShowtimeEvent | null>(null);
  const [attempts, setAttempts] = useState<number>(0);

  // Keep the latest onEvent callback in a ref so consumers don't have to
  // memoise it — re-renders shouldn't force a WebSocket reconnect.
  const onEventRef = useRef<typeof onEvent>(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Connection lifecycle managed via refs so the cleanup closure always
  // sees the *current* socket / timer, not a stale snapshot.
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef<number>(0);
  const disposedRef = useRef<boolean>(false);

  const cleanupSocket = useCallback((): void => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (socketRef.current) {
      // Drop the listeners first so we don't trigger our own close handler.
      socketRef.current.onopen = null;
      socketRef.current.onmessage = null;
      socketRef.current.onerror = null;
      socketRef.current.onclose = null;
      try {
        socketRef.current.close();
      } catch {
        // ignore — socket may already be in a terminal state
      }
      socketRef.current = null;
    }
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    if (!enabled || !showtimeUuid) {
      setStatus("idle");
      cleanupSocket();
      return;
    }

    function scheduleReconnect(): void {
      if (disposedRef.current) return;
      const n = attemptsRef.current;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_CAP_MS);
      setStatus("reconnecting");
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        attemptsRef.current = n + 1;
        setAttempts(n + 1);
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposedRef.current) return;
      cleanupSocket();
      setStatus("connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(`${wsBaseUrl()}/ws/${showtimeUuid}`);
      } catch {
        setStatus("error");
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposedRef.current) return;
        attemptsRef.current = 0;
        setAttempts(0);
        setStatus("open");
      };

      socket.onmessage = (msg) => {
        if (disposedRef.current) return;
        let parsed: ShowtimeEvent | null = null;
        try {
          const data: unknown = JSON.parse(msg.data as string);
          if (
            data &&
            typeof data === "object" &&
            "type" in data &&
            (data as { type: unknown }).type
          ) {
            parsed = data as ShowtimeEvent;
          }
        } catch {
          return; // malformed frame — ignore
        }
        if (!parsed) return;
        setLastEvent(parsed);
        onEventRef.current?.(parsed);
      };

      socket.onerror = () => {
        // No reliable detail here. Let onclose drive reconnect logic.
        if (disposedRef.current) return;
        setStatus("error");
      };

      socket.onclose = (ev) => {
        if (disposedRef.current) return;
        if (TERMINAL_CLOSE_CODES.has(ev.code)) {
          setStatus("closed");
          return;
        }
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      disposedRef.current = true;
      cleanupSocket();
    };
  }, [showtimeUuid, enabled, cleanupSocket]);

  return { status, lastEvent, attempts };
}
