import Link from "next/link";

import { Wordmark } from "./Wordmark";
import styles from "./TopBar.module.css";

export function TopBar(): JSX.Element {
  return (
    <header className={styles.bar} aria-label="Site header">
      <div className={`${styles.inner} container`}>
        <Link href="/" className={styles.brand} aria-label="Cinewatcher — home">
          <Wordmark size="sm" />
        </Link>
        <nav className={styles.nav} aria-label="Primary">
          <span className={styles.pill}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.pillLabel}>Live</span>
            <span className={styles.pillRule} aria-hidden="true" />
            <span className={styles.pillMeta}>Box office open</span>
          </span>
          <a className={styles.link} href="/#how">How it works</a>
          <Link className={styles.link} href="/dashboard">Watchlist</Link>
          <a className={styles.link} href="/#members">Members</a>
        </nav>
      </div>
      <div className={styles.rule} aria-hidden="true" />
    </header>
  );
}
