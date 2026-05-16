"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  cancelWatch,
  getMe,
  listWatches,
} from "@/lib/api";
import type { CurrentUser, Watch, WatchStatus } from "@/lib/api";
// TEST FIXTURE — preview-mode session helpers; see lib/test/fixtures.ts.
import { clearTestSession, hasTestSession } from "@/lib/test/fixtures";
import { WatchCardLive } from "./WatchCardLive";
import styles from "./Dashboard.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; user: CurrentUser; watches: Watch[] };

type FilterKey = "all" | WatchStatus;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "fulfilled", label: "Fulfilled" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

export function DashboardClient(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<FilterKey>("active");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const user = await getMe();
      if (!user) {
        setState({ kind: "signed-out" });
        return;
      }
      const watches = await listWatches("all");
      setState({ kind: "ready", user, watches });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't reach the box office.";
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCancel = useCallback(
    async (watch: Watch): Promise<void> => {
      if (cancellingId) return;
      setCancelError(null);
      setCancellingId(watch.id);
      try {
        const updated = await cancelWatch(watch.id);
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          return {
            ...prev,
            watches: prev.watches.map((w) =>
              w.id === updated.id ? updated : w,
            ),
          };
        });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Couldn't cancel that watch.";
        setCancelError(message);
      } finally {
        setCancellingId(null);
      }
    },
    [cancellingId],
  );

  const counts = useMemo(() => {
    if (state.kind !== "ready") {
      return { all: 0, active: 0, fulfilled: 0, cancelled: 0, expired: 0 };
    }
    const init = { all: 0, active: 0, fulfilled: 0, cancelled: 0, expired: 0 };
    for (const w of state.watches) {
      init.all += 1;
      init[w.status] += 1;
    }
    return init;
  }, [state]);

  const visibleWatches = useMemo<Watch[]>(() => {
    if (state.kind !== "ready") return [];
    const list =
      filter === "all"
        ? state.watches
        : state.watches.filter((w) => w.status === filter);
    return [...list].sort((a, b) => {
      // Active first, then most-recently-created.
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  }, [state, filter]);

  return (
    <>
      <DashboardHeader counts={counts} userEmail={userEmailOf(state)} />

      {state.kind === "ready" ? (
        <>
          <FilterTabs filter={filter} onChange={setFilter} counts={counts} />

          {cancelError ? (
            <div className={styles.banner} role="alert">
              <span className={styles.bannerTag}>Error</span>
              <span>{cancelError}</span>
            </div>
          ) : null}

          {visibleWatches.length === 0 ? (
            <EmptyState filter={filter} hasAny={counts.all > 0} />
          ) : (
            <ul className={styles.grid}>
              {visibleWatches.map((w) => (
                <li key={w.id} className={styles.gridItem}>
                  <WatchCardLive
                    watch={w}
                    onCancel={onCancel}
                    cancelling={cancellingId === w.id}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {state.kind === "loading" ? <SkeletonGrid /> : null}

      {state.kind === "signed-out" ? <SignedOutPanel /> : null}

      {state.kind === "error" ? (
        <ErrorPanel message={state.message} onRetry={() => void load()} />
      ) : null}
    </>
  );
}

// --- header --------------------------------------------------------------

function userEmailOf(state: LoadState): string | null {
  return state.kind === "ready" ? state.user.email : null;
}

function DashboardHeader({
  counts,
  userEmail,
}: {
  counts: { all: number; active: number; fulfilled: number };
  userEmail: string | null;
}): JSX.Element {
  // TEST FIXTURE — render an "Exit preview" affordance when a fake session
  // is active, so the developer can leave preview mode without clearing
  // localStorage by hand.
  const inTestMode = hasTestSession();
  const onExitTest = (): void => {
    clearTestSession();
    window.location.reload();
  };
  return (
    <header className={styles.head}>
      <div className={styles.eyebrowRow}>
        <span className={styles.eyebrow}>Watchlist</span>
        {userEmail ? (
          <span className={styles.identity}>
            <span className={styles.identityLabel}>Signed in</span>
            <span className={styles.identityRule} aria-hidden="true" />
            <span className={styles.identityValue}>{userEmail}</span>
          </span>
        ) : null}
        {inTestMode ? (
          <button
            type="button"
            className={styles.exitTest}
            onClick={onExitTest}
          >
            <span className={styles.exitTestTag}>Preview</span>
            <span>Exit test mode</span>
          </button>
        ) : null}
      </div>

      <h1 className={styles.title}>
        Your <span className={styles.italic}>watchlist</span>.
      </h1>

      <p className={styles.lede}>
        Every showtime you're tracking, in one place. We watch the box office —
        you wait for the ping.
      </p>

      <div className={styles.tally}>
        <span className={styles.tallyItem}>
          <span className={styles.tallyNum}>{counts.active}</span>
          <span className={styles.tallyLabel}>Active</span>
        </span>
        <span className={styles.tallyDot} aria-hidden="true" />
        <span className={styles.tallyItem}>
          <span className={styles.tallyNum}>{counts.fulfilled}</span>
          <span className={styles.tallyLabel}>Fulfilled</span>
        </span>
        <span className={styles.tallyDot} aria-hidden="true" />
        <span className={styles.tallyItem}>
          <span className={styles.tallyNum}>{counts.all}</span>
          <span className={styles.tallyLabel}>Total</span>
        </span>
      </div>
    </header>
  );
}

// --- filter tabs ---------------------------------------------------------

function FilterTabs({
  filter,
  onChange,
  counts,
}: {
  filter: FilterKey;
  onChange: (k: FilterKey) => void;
  counts: Record<FilterKey, number>;
}): JSX.Element {
  return (
    <nav className={styles.tabs} aria-label="Filter watches by status">
      {FILTERS.map((f) => {
        const active = filter === f.key;
        return (
          <button
            key={f.key}
            type="button"
            className={`${styles.tab} ${active ? styles.tabActive : ""}`}
            aria-pressed={active}
            onClick={() => onChange(f.key)}
          >
            <span>{f.label}</span>
            <span className={styles.tabCount}>{counts[f.key]}</span>
          </button>
        );
      })}
    </nav>
  );
}

// --- empty / loading / error states -------------------------------------

function EmptyState({
  filter,
  hasAny,
}: {
  filter: FilterKey;
  hasAny: boolean;
}): JSX.Element {
  if (!hasAny) {
    return (
      <section className={styles.empty} aria-label="No watches yet">
        <span className={styles.emptyEyebrow}>Quiet house</span>
        <p className={styles.emptyTitle}>You aren't watching anything yet.</p>
        <p className={styles.emptyBody}>
          Drop a Cineplex showtime URL on the homepage and pick the seats you
          want to track. The watchlist fills up from there.
        </p>
        <Link href="/" className={styles.emptyCta}>
          <span>Start a watch</span>
          <span className={styles.arrow} aria-hidden="true">→</span>
        </Link>
      </section>
    );
  }
  return (
    <section className={styles.empty} aria-label="No watches in this filter">
      <span className={styles.emptyEyebrow}>Nothing here</span>
      <p className={styles.emptyTitle}>
        No watches in {filter === "all" ? "this view" : filter}.
      </p>
      <p className={styles.emptyBody}>
        Try a different filter, or start a new watch from the homepage.
      </p>
    </section>
  );
}

function SignedOutPanel(): JSX.Element {
  return (
    <section className={styles.panel} aria-label="Sign in required">
      <span className={styles.panelEyebrow}>Members only</span>
      <p className={styles.panelTitle}>Sign in to view your watchlist.</p>
      <p className={styles.panelBody}>
        Magic-link login, no password. We'll email you a one-time link to come
        back to this page.
      </p>
      <Link href="/#members" className={styles.panelCta}>
        <span>Sign in by email</span>
        <span className={styles.arrow} aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <section className={styles.panel} aria-label="Couldn't load watches">
      <span className={`${styles.panelEyebrow} ${styles.panelEyebrowWarn}`}>
        Connection lost
      </span>
      <p className={styles.panelTitle}>We couldn't load your watchlist.</p>
      <p className={styles.panelBody}>{message}</p>
      <button type="button" className={styles.panelCta} onClick={onRetry}>
        <span>Try again</span>
        <span className={styles.arrow} aria-hidden="true">↻</span>
      </button>
    </section>
  );
}

function SkeletonGrid(): JSX.Element {
  return (
    <div className={styles.skeletonWrap} aria-hidden="true">
      <div className={styles.skeletonTabs}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={styles.skeletonTab} />
        ))}
      </div>
      <ul className={styles.grid}>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className={styles.gridItem}>
            <div className={styles.skeletonCard}>
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonTitle} />
              <div className={styles.skeletonMeta} />
              <div className={styles.skeletonChips}>
                <span /><span /><span /><span /><span />
              </div>
              <div className={styles.skeletonFoot} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
