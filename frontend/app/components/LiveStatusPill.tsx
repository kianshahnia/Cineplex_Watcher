import type { WsStatus } from "@/hooks/useShowtimeEvents";
import styles from "./LiveStatusPill.module.css";

interface Props {
  status: WsStatus;
  /** Optional override label for the "open" state — defaults to "Live". */
  liveLabel?: string;
  /** When true, prefix the label with a mono "WS" token. */
  technical?: boolean;
}

function copyFor(status: WsStatus): { label: string; tone: string } {
  switch (status) {
    case "open":
      return { label: "Live", tone: "live" };
    case "connecting":
      return { label: "Connecting", tone: "warming" };
    case "reconnecting":
      return { label: "Reconnecting", tone: "warming" };
    case "closed":
      return { label: "Closed", tone: "muted" };
    case "error":
      return { label: "Offline", tone: "muted" };
    case "idle":
    default:
      return { label: "Idle", tone: "muted" };
  }
}

export function LiveStatusPill({
  status,
  liveLabel,
  technical,
}: Props): JSX.Element {
  const c = copyFor(status);
  const label = status === "open" && liveLabel ? liveLabel : c.label;
  return (
    <span
      className={`${styles.pill} ${styles[`tone_${c.tone}`]}`}
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      {technical ? <span className={styles.token}>WS</span> : null}
      <span className={styles.label}>{label}</span>
    </span>
  );
}
