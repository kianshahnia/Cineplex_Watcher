import { SeatGridMark } from "./SeatGridMark";
import styles from "./Wordmark.module.css";

export function Wordmark({
  size = "sm",
}: {
  size?: "sm" | "md";
}): JSX.Element {
  return (
    <span className={`${styles.mark} ${size === "md" ? styles.md : styles.sm}`}>
      <SeatGridMark size={size === "md" ? "md" : "sm"} label="Cinewatcher" />
      <span className={styles.lockup}>
        <span className={styles.name}>Cinewatcher</span>
      </span>
    </span>
  );
}
