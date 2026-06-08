"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

import { getNowPlaying, type NowPlayingMovie } from "@/lib/api";
import { SeatGridMark } from "./SeatGridMark";
import styles from "./NowPlayingCarousel.module.css";

// Where every poster sends the user — Cineplex's "find showtimes" entry point.
// `openTM=true` pops their ticket-modal on arrival.
const CINEPLEX_URL = "https://www.cineplex.com/?openTM=true";

// Auto-advance cadence. Paused while the pointer is over the frame so a user
// reading a title isn't yanked to the next poster mid-glance.
const ROTATE_MS = 5000;

type LoadState = "loading" | "ready" | "empty";

/**
 * The hero aside's "Now Playing" poster carousel.
 *
 * Fetches the popularity-ranked now-playing list from our backend (which holds
 * the TMDB token and caches the result). Posters crossfade on a timer; hovering
 * pauses the timer and reveals prev/next arrows. Clicking a poster opens
 * Cineplex in a new tab. If the backend has no posters to give (TMDB not
 * configured, or it's down), the widget degrades to the brand seat-grid motif
 * rather than showing an error on a decorative element.
 */
export function NowPlayingCarousel(): JSX.Element {
  const [movies, setMovies] = useState<NowPlayingMovie[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  // Fetch once on mount. A failure degrades to the fallback motif.
  useEffect(() => {
    let alive = true;
    getNowPlaying()
      .then((data) => {
        if (!alive) return;
        if (data.length === 0) {
          setState("empty");
          return;
        }
        setMovies(data);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("empty");
      });
    return () => {
      alive = false;
    };
  }, []);

  const count = movies.length;

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      // Wrap in both directions so the prev arrow loops past zero.
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  // Auto-rotate. The effect re-runs whenever `index` changes, so each manual
  // arrow press also resets the clock — you get a full interval before the next
  // automatic advance. Reduced-motion users get no auto-advance at all.
  useEffect(() => {
    if (state !== "ready" || paused || count <= 1) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const id = window.setTimeout(() => go(index + 1), ROTATE_MS);
    return () => window.clearTimeout(id);
  }, [state, paused, count, index, go]);

  if (state === "loading") {
    return (
      <div className={styles.root} aria-hidden="true">
        <div className={`${styles.frame} ${styles.skeleton}`} />
        <Caption label="Now Playing" sub="Loading showtimes…" />
      </div>
    );
  }

  if (state === "empty") {
    return (
      <div className={styles.root}>
        <a
          className={`${styles.frame} ${styles.fallback}`}
          href={CINEPLEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Browse what's playing on Cineplex"
        >
          <SeatGridMark size="lg" dim />
        </a>
        <Caption label="Now Playing" sub="Browse on Cineplex ↗" />
      </div>
    );
  }

  const active = movies[index]!;

  return (
    <div
      className={styles.root}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className={styles.frame}>
        <a
          className={styles.posterLink}
          href={CINEPLEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Now playing: ${active.title}. Find showtimes on Cineplex.`}
        >
          <div className={styles.stack}>
            {movies.map((movie, i) => (
              <Image
                key={movie.id}
                src={movie.poster_url}
                alt={movie.title}
                fill
                sizes="(max-width: 880px) 200px, 248px"
                className={styles.poster}
                style={{ opacity: i === index ? 1 : 0 }}
                priority={i === 0}
              />
            ))}
          </div>
          <span className={styles.hint}>Find showtimes ↗</span>
        </a>

        {count > 1 ? (
          <>
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowLeft}`}
              onClick={() => go(index - 1)}
              aria-label="Previous movie"
            >
              ‹
            </button>
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowRight}`}
              onClick={() => go(index + 1)}
              aria-label="Next movie"
            >
              ›
            </button>
          </>
        ) : null}
      </div>

      <Caption label="Now Playing" sub={active.title} meta={metaLine(active)} />

      {count > 1 ? (
        <div className={styles.dots} role="tablist" aria-label="Choose a movie">
          {movies.map((movie, i) => (
            <button
              key={movie.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={movie.title}
              className={`${styles.dot} ${i === index ? styles.dotActive : ""}`}
              onClick={() => go(i)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Caption({
  label,
  sub,
  meta,
}: {
  label: string;
  sub?: string;
  meta?: string;
}): JSX.Element {
  return (
    <div className={styles.caption}>
      <span className={styles.eyebrow}>{label}</span>
      {sub ? <span className={styles.title}>{sub}</span> : null}
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </div>
  );
}

/** "2026  ·  ★ 7.8" — whichever parts exist. */
function metaLine(movie: NowPlayingMovie): string | undefined {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : undefined;
  const rating =
    movie.vote_average > 0 ? `★ ${movie.vote_average.toFixed(1)}` : undefined;
  return [year, rating].filter(Boolean).join("  ·  ") || undefined;
}
