import Link from "next/link";

import styles from "./WatchError.module.css";

export function WatchError({
  message,
  theatreId,
  showtimeId,
}: {
  message: string;
  theatreId: number;
  showtimeId: number;
}): JSX.Element {
  return (
    <section className={styles.wrap}>
      <span className={styles.kicker}>Couldn&apos;t load this showtime</span>
      <h1 className={styles.title}>The box office is quiet.</h1>
      <p className={styles.body}>{message}</p>
      <div className={styles.tech}>
        <span className={styles.techItem}>Theatre {theatreId}</span>
        <span className={styles.techDot} aria-hidden="true" />
        <span className={styles.techItem}>Showtime {showtimeId}</span>
      </div>
      <Link className={styles.cta} href="/">
        <span>Back to the home page</span>
        <span className={styles.ctaArrow} aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
