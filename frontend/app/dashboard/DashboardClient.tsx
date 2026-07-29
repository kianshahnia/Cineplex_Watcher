"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  ApiError,
  cancelWatch,
  getMe,
  listWatches,
  removeWatch,
  updateWatch,
} from "@/lib/api";
import type { CurrentUser, Watch, WatchStatus } from "@/lib/api";
import {
  MAX_REMEMBERED_EXPANDED,
  defaultPrefs,
  loadPrefs,
  normalizePrefs,
  savePrefs,
} from "@/lib/dashboardPrefs";
import type { DashboardPrefs } from "@/lib/dashboardPrefs";
import {
  GROUP_BY_VALUES,
  groupWatches,
  sortOptionsFor,
} from "@/lib/watchGrouping";
import type { GroupBy, SortBy } from "@/lib/watchGrouping";
import { WatchCard } from "./WatchCard";
import { WatchGroupCard } from "./WatchGroupCard";
import styles from "./Dashboard.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; user: CurrentUser; watches: Watch[] };

type FilterKey = "all" | WatchStatus;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All" },
];

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  movie: "Movie",
  date: "Date",
  theatre: "Theatre",
  format: "Format",
  none: "None",
};

const SORT_BY_LABEL: Record<SortBy, string> = {
  showtime: "Soonest showtime",
  added: "Recently added",
  name: "Name",
  format: "Format",
  theatre: "Theatre",
};

export function DashboardClient(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<FilterKey>("active");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // How the list is grouped and sorted, and which rows are open. Persisted to
  // localStorage — see the hydration pair below.
  const [prefs, setPrefs] = useState<DashboardPrefs>(defaultPrefs);
  const [hydrated, setHydrated] = useState(false);

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
            : "Couldn’t reach the box office.";
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Read the stored preferences in a mount effect, never during render: this
  // component is still server-rendered, so an inline localStorage read would
  // desync hydration — the same reason `WatchInteractive` restores its seat
  // selection in an effect.
  useEffect(() => {
    setPrefs(loadPrefs());
    setHydrated(true);
  }, []);

  // Write them back on every change. `hydrated` is state rather than a ref so
  // this can't fire on the first commit and overwrite the stored blob with the
  // defaults before the load effect's result has landed.
  useEffect(() => {
    if (!hydrated) return;
    savePrefs(prefs);
  }, [hydrated, prefs]);

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
              : "Couldn’t cancel that watch.";
        setCancelError(message);
      } finally {
        setCancellingId(null);
      }
    },
    [cancellingId],
  );

  const onRemove = useCallback(
    async (watch: Watch): Promise<void> => {
      if (removingId) return;
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          "Remove this watch permanently? This can’t be undone.",
        )
      ) {
        return;
      }
      setCancelError(null);
      setRemovingId(watch.id);
      try {
        await removeWatch(watch.id);
        // Drop it from the local list — no re-fetch needed.
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          return {
            ...prev,
            watches: prev.watches.filter((w) => w.id !== watch.id),
          };
        });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Couldn’t remove that watch.";
        setCancelError(message);
      } finally {
        setRemovingId(null);
      }
    },
    [removingId],
  );

  const onRename = useCallback(
    async (watch: Watch, name: string | null): Promise<void> => {
      setCancelError(null);
      setRenamingId(watch.id);
      try {
        const updated = await updateWatch(watch.id, { name });
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
              : "Couldn’t rename that watch.";
        setCancelError(message);
        // Re-throw so the card keeps its inline editor open for a retry.
        throw err;
      } finally {
        setRenamingId(null);
      }
    },
    [],
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

  // Status filtering only — ordering now belongs to `groupWatches`, which sorts
  // within each group and between them from a total comparator, so the order
  // here could not influence the result anyway.
  const visibleWatches = useMemo<Watch[]>(() => {
    if (state.kind !== "ready") return [];
    return filter === "all"
      ? state.watches
      : state.watches.filter((w) => w.status === filter);
  }, [state, filter]);

  const groups = useMemo(
    () => groupWatches(visibleWatches, prefs.groupBy, prefs.sortBy),
    [visibleWatches, prefs.groupBy, prefs.sortBy],
  );

  const expandedSet = useMemo(
    () => new Set(prefs.expanded),
    [prefs.expanded],
  );

  // Collapsing the only group on the page is pointless, so a lone group always
  // renders open regardless of what's remembered.
  const soleGroup = groups.length === 1;
  const isOpen = useCallback(
    (key: string): boolean => soleGroup || expandedSet.has(key),
    [soleGroup, expandedSet],
  );

  const onToggleGroup = useCallback((key: string): void => {
    setPrefs((prev) => {
      const expanded = prev.expanded.includes(key)
        ? prev.expanded.filter((k) => k !== key)
        : // Newest first, so the cap evicts the least recently opened row.
          [key, ...prev.expanded].slice(0, MAX_REMEMBERED_EXPANDED);
      return { ...prev, expanded };
    });
  }, []);

  // Switching modes goes through `normalizePrefs`, so a `sortBy` the new mode
  // doesn't offer resets to the default instead of silently doing nothing.
  const onGroupByChange = useCallback((groupBy: GroupBy): void => {
    setPrefs((prev) => normalizePrefs({ ...prev, groupBy }));
  }, []);

  const onSortByChange = useCallback((sortBy: SortBy): void => {
    setPrefs((prev) => normalizePrefs({ ...prev, sortBy }));
  }, []);

  const allExpanded = groups.length > 0 && groups.every((g) => isOpen(g.key));

  // Only the rows currently on screen are touched — keys belonging to another
  // grouping mode or another status filter keep whatever state they had.
  const onToggleAll = useCallback((): void => {
    const keys = groups.map((g) => g.key);
    const onScreen = new Set(keys);
    setPrefs((prev) => {
      const untouched = prev.expanded.filter((k) => !onScreen.has(k));
      return {
        ...prev,
        expanded: allExpanded
          ? untouched
          : [...keys, ...untouched].slice(0, MAX_REMEMBERED_EXPANDED),
      };
    });
  }, [groups, allExpanded]);

  // The render prop the group rows call for each member. Every handler and busy
  // flag stays exactly as it was before grouping — the row never sees them.
  const renderWatch = useCallback(
    (w: Watch): JSX.Element => (
      <li key={w.id} className={styles.gridItem}>
        <WatchCard
          watch={w}
          onCancel={onCancel}
          cancelling={cancellingId === w.id}
          onRemove={onRemove}
          removing={removingId === w.id}
          onRename={onRename}
          renaming={renamingId === w.id}
        />
      </li>
    ),
    [
      onCancel,
      cancellingId,
      onRemove,
      removingId,
      onRename,
      renamingId,
    ],
  );

  return (
    <>
      <DashboardHeader counts={counts} userEmail={userEmailOf(state)} />

      {state.kind === "ready" ? (
        <>
          <FilterTabs filter={filter} onChange={setFilter} counts={counts} />

          {visibleWatches.length > 0 ? (
            <GroupToolbar
              groupBy={prefs.groupBy}
              sortBy={prefs.sortBy}
              onGroupBy={onGroupByChange}
              onSortBy={onSortByChange}
              onToggleAll={onToggleAll}
              allExpanded={allExpanded}
              // With one group there is nothing to expand *all* of — it is
              // already open by the lone-group rule.
              showToggleAll={groups.length > 1}
            />
          ) : null}

          {cancelError ? (
            <div className={styles.banner} role="alert">
              <span className={styles.bannerTag}>Error</span>
              <span>{cancelError}</span>
            </div>
          ) : null}

          {visibleWatches.length === 0 ? (
            <EmptyState filter={filter} hasAny={counts.all > 0} />
          ) : (
            <div className={styles.groups}>
              {groups.map((g) => (
                <WatchGroupCard
                  key={g.key}
                  group={g}
                  expanded={isOpen(g.key)}
                  onToggle={onToggleGroup}
                  renderWatch={renderWatch}
                />
              ))}
            </div>
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
      </div>

      <h1 className={styles.title}>
        Your watchlist
      </h1>

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

// --- group / sort toolbar ------------------------------------------------

/**
 * Group-by chips plus a sort control, sitting between the status tabs and the
 * group list.
 *
 * The chips are `aria-pressed` buttons rather than ARIA tabs — there is no
 * one-panel-per-chip relationship, and `FilterTabs` above already established
 * that convention. They are styled as outlined pills instead of reusing the
 * underlined `.tab` look, so two control rows stacked on top of each other stay
 * visually distinguishable: status is the primary tab row, grouping is a
 * secondary control.
 *
 * The sort control is a native `<select>` with `appearance: none`. Native buys
 * keyboard, mobile and screen-reader behaviour for free; the repo has no
 * dropdown component to reuse, and OS-controlled option styling is accepted.
 */
function GroupToolbar({
  groupBy,
  sortBy,
  onGroupBy,
  onSortBy,
  onToggleAll,
  allExpanded,
  showToggleAll,
}: {
  groupBy: GroupBy;
  sortBy: SortBy;
  onGroupBy: (g: GroupBy) => void;
  onSortBy: (s: SortBy) => void;
  onToggleAll: () => void;
  allExpanded: boolean;
  showToggleAll: boolean;
}): JSX.Element {
  const selectId = useId();
  const sortOptions = sortOptionsFor(groupBy);

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarSet} role="group" aria-label="Group watches by">
        <span className={styles.toolbarLabel}>Group by</span>
        {GROUP_BY_VALUES.map((g) => {
          const active = groupBy === g;
          return (
            <button
              key={g}
              type="button"
              className={`${styles.chip} ${active ? styles.chipActive : ""}`}
              aria-pressed={active}
              onClick={() => onGroupBy(g)}
            >
              {GROUP_BY_LABEL[g]}
            </button>
          );
        })}
      </div>

      <div className={styles.toolbarAside}>
        <label className={styles.toolbarLabel} htmlFor={selectId}>
          Sort
        </label>
        <span className={styles.selectWrap}>
          <select
            id={selectId}
            className={styles.select}
            value={sortBy}
            onChange={(e) => {
              // Resolve against the offered list rather than casting the raw
              // value — the options are the only valid inputs.
              const next = sortOptions.find((s) => s === e.target.value);
              if (next) onSortBy(next);
            }}
          >
            {sortOptions.map((s) => (
              <option key={s} value={s}>
                {SORT_BY_LABEL[s]}
              </option>
            ))}
          </select>
          <span className={styles.selectChevron} aria-hidden="true">
            ⌄
          </span>
        </span>

        {showToggleAll ? (
          <button
            type="button"
            className={styles.expandBtn}
            onClick={onToggleAll}
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </div>
    </div>
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
        <p className={styles.emptyTitle}>You aren’t watching anything yet.</p>
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
        Magic-link login, no password. We’ll email you a one-time link to come
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
    <section className={styles.panel} aria-label="Couldn’t load watches">
      <span className={`${styles.panelEyebrow} ${styles.panelEyebrowWarn}`}>
        Connection lost
      </span>
      <p className={styles.panelTitle}>We couldn’t load your watchlist.</p>
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
