"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError, parseShowtimeUrl } from "@/lib/api";
import { SeatGridMark } from "./SeatGridMark";
import styles from "./UrlInputCard.module.css";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function UrlInputCard(): JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState("--  --  --");

  useEffect(() => {
    const fmt = (): string => {
      const d = new Date();
      return `${pad(d.getHours())}  ${pad(d.getMinutes())}  ${pad(d.getSeconds())}`;
    };
    setClock(fmt());
    const id = setInterval(() => setClock(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!url.trim() || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { theatre_id, showtime_id } = await parseShowtimeUrl(url.trim());
      router.push(`/watch/${theatre_id}-${showtime_id}`);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't reach the box office. Try again in a moment.";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <section
      className={`${styles.hero} container`}
      aria-label="Enter a Cineplex showtime URL"
      id="top"
    >
      <div className={styles.head}>
        <span className={styles.eyebrow}>
          <span className={styles.brassPip} aria-hidden="true" />
          Now Showing — 2026
        </span>
        <span className={styles.edition}>Vol. I · Issue 01</span>
      </div>

      <div className={styles.grid}>
        <div className={styles.lead}>
          <h1 className={styles.headline}>
            Catch the seat
            <br />
            the <em className={styles.italic}>moment</em> it opens.
          </h1>

          <p className={styles.lede}>
            Cinewatcher tracks any Cineplex showtime and pings you the second a
            seat clears — email, text, or push. No refreshing, no checking
            back. Just paste a link.
          </p>

          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>URL</span>
              <span className={styles.fieldRule} aria-hidden="true" />
              <input
                className={styles.input}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="cineplex.com/ticketing/preview?theatreId=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Cineplex showtime URL"
                required
              />
            </div>
            <button
              type="submit"
              className={styles.submit}
              disabled={loading || url.trim().length === 0}
              aria-busy={loading}
            >
              <span className={styles.submitText}>
                {loading ? "Reading" : "Watch"}
              </span>
              <span className={styles.submitArrow} aria-hidden="true">
                {loading ? "…" : "→"}
              </span>
            </button>
          </form>

          <p className={styles.helper}>
            Accepts both <code>cineplex.com/ticketing/preview?…</code> and the
            raw <code>apis.cineplex.com/…/seat-availability</code> endpoint.
          </p>

          {error ? (
            <div className={styles.error} role="alert">
              <span className={styles.errorTag}>Error</span>
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <aside className={styles.aside}>
          <div className={styles.asideTop}>
            <div className={styles.asideLabel}>Scene</div>
            <div className={styles.asideNumeral}>I</div>
          </div>

          <div className={styles.asideMark} aria-hidden="true">
            <SeatGridMark size="lg" dim />
          </div>

          <div className={styles.asideFoot}>
            <div className={styles.asideRule} />
            <div className={styles.asideClock}>{clock}</div>
            <div className={styles.asideStatus}>
              <span className={styles.statusDot} aria-hidden="true" />
              Standby — awaiting URL
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
