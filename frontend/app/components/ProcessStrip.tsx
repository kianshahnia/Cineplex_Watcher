import styles from "./ProcessStrip.module.css";

const STEPS = [
  {
    n: "01",
    title: "Paste",
    body: "Drop any Cineplex showtime URL into the box above. We pull the live seat map straight from the box office.",
  },
  {
    n: "02",
    title: "Pick",
    body: "Tap the seats you want to track: a single seat, a row, or every seat in the house. We keep watch from there.",
  },
  {
    n: "03",
    title: "Get notified",
    body: "Email, SMS, or push the second a watched seat opens up. Each alert links straight back to Cineplex to book.",
  },
] as const;

export function ProcessStrip(): JSX.Element {
  return (
    <section
      id="how"
      className={`${styles.strip} container`}
      aria-label="How it works"
    >
      <div className={styles.divider} aria-hidden="true" />

      <header className={styles.head}>
        <span className={styles.kicker}>How it works</span>
        <h2 className={styles.title}>
          Three steps, no accounts required.
        </h2>
      </header>

      <ol className={styles.steps}>
        {STEPS.map((s) => (
          <li className={styles.step} key={s.n}>
            <span className={styles.num}>{s.n}</span>
            <h3 className={styles.stepTitle}>{s.title}</h3>
            <p className={styles.stepBody}>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
