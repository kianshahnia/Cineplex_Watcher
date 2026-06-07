import Link from "next/link";

import { AuthNav } from "./AuthNav";
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
          <a
            className={`${styles.link} ${styles.linkSecondary}`}
            href="/#how"
          >
            How it works
          </a>
          <Link className={styles.link} href="/dashboard">Watchlist</Link>
          <AuthNav />
        </nav>
      </div>
      <div className={styles.rule} aria-hidden="true" />
    </header>
  );
}
