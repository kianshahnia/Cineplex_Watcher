import { Wordmark } from "./Wordmark";
import styles from "./Footer.module.css";

export function Footer(): JSX.Element {
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={`${styles.inner} container`}>
        <div className={styles.col}>
          <Wordmark size="sm" />
          <p className={styles.tagline}>
            Didn't catch a seat? We'll let you know when one opens.
          </p>
        </div>

        <div className={styles.colRight}>
          <p className={styles.disclaimer}>
            Unaffiliated with Cineplex Entertainment. No ticket sales — this is
            a notification companion only.
          </p>
          <div className={styles.meta}>
            <span className={styles.metaItem}>{year} Cinewatcher</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
