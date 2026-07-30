"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  ApiError,
  MAX_BULK_WATCHES,
  deleteWatches,
  getMe,
  listWatches,
  renameWatches,
  updateWatch,
} from "@/lib/api";
import type { CurrentUser, Watch } from "@/lib/api";
import {
  MAX_REMEMBERED_EXPANDED,
  defaultPrefs,
  loadPrefs,
  normalizePrefs,
  savePrefs,
} from "@/lib/dashboardPrefs";
import type { DashboardPrefs } from "@/lib/dashboardPrefs";
import { chunkIds, selectStateOf, toggleGroup, toggleOne } from "@/lib/bulkSelection";
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

/**
 * Two tabs, and "expired" means **everything that isn't active** — not the
 * literal `expired` status (docs/bugs.md #15).
 *
 * That distinction is load-bearing. `cancelled` rows still exist from before
 * bugs.md #8 made deletion permanent, and the poller retires a fully-delivered
 * watch by status. Filtering on status equality would leave those rows in the
 * database, owned by the user, and reachable from no tab at all — so there'd be
 * no way to see or delete them. A predicate can't develop that hole as statuses
 * come and go.
 */
type FilterKey = "active" | "expired";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "expired", label: "Expired" },
];

function matchesFilter(w: Watch, filter: FilterKey): boolean {
  return filter === "active" ? w.status === "active" : w.status !== "active";
}

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

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function DashboardClient(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<FilterKey>("active");
  // A set, not a single id: deleting no longer asks for confirmation, so users
  // click through several cards fast and a single-flight guard would silently
  // swallow every click after the first.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // --- edit mode ---------------------------------------------------------
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkName, setBulkName] = useState("");
  const [bulkBusy, setBulkBusy] = useState<"delete" | "rename" | null>(null);
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

  /** Drop watches from local state — used by both the single and bulk paths. */
  const forget = useCallback((ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setState((prev) =>
      prev.kind === "ready"
        ? { ...prev, watches: prev.watches.filter((w) => !gone.has(w.id)) }
        : prev,
    );
    setSelectedIds((prev) => {
      if (![...gone].some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of gone) next.delete(id);
      return next;
    });
  }, []);

  /**
   * Delete one watch, permanently and without a confirmation.
   *
   * Cancel and Remove used to be two buttons — a soft archive and a hard
   * delete — which was a distinction nobody wanted. There is one now, and it
   * goes through the same bulk endpoint the edit bar uses, so "delete watches"
   * has exactly one implementation.
   */
  const onDelete = useCallback(
    async (watch: Watch): Promise<void> => {
      if (deletingIds.has(watch.id)) return;
      setActionError(null);
      setDeletingIds((prev) => new Set(prev).add(watch.id));
      try {
        await deleteWatches([watch.id]);
        forget([watch.id]);
      } catch (err) {
        setActionError(messageOf(err, "Couldn’t remove that watch."));
      } finally {
        setDeletingIds((prev) => {
          if (!prev.has(watch.id)) return prev;
          const next = new Set(prev);
          next.delete(watch.id);
          return next;
        });
      }
    },
    [deletingIds, forget],
  );

  const onRename = useCallback(
    async (watch: Watch, name: string | null): Promise<void> => {
      setActionError(null);
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
        setActionError(messageOf(err, "Couldn’t rename that watch."));
        // Re-throw so the card keeps its inline editor open for a retry.
        throw err;
      } finally {
        setRenamingId(null);
      }
    },
    [],
  );

  // One tally per tab plus the total, computed from the full list so both tab
  // counts are right whichever tab is open.
  const counts = useMemo<Record<FilterKey, number> & { total: number }>(() => {
    if (state.kind !== "ready") return { active: 0, expired: 0, total: 0 };
    const active = state.watches.filter((w) => w.status === "active").length;
    return {
      active,
      expired: state.watches.length - active,
      total: state.watches.length,
    };
  }, [state]);

  // Status filtering only — ordering now belongs to `groupWatches`, which sorts
  // within each group and between them from a total comparator, so the order
  // here could not influence the result anyway.
  const visibleWatches = useMemo<Watch[]>(() => {
    if (state.kind !== "ready") return [];
    return state.watches.filter((w) => matchesFilter(w, filter));
  }, [state, filter]);

  const groups = useMemo(
    () => groupWatches(visibleWatches, prefs.groupBy, prefs.sortBy),
    [visibleWatches, prefs.groupBy, prefs.sortBy],
  );

  // --- multi-select ------------------------------------------------------

  // Switching tabs hides cards, and acting on something you can't see is how a
  // bulk delete becomes a horror story. Grouping/sorting changes are safe by
  // contrast — they rearrange the same cards — so they don't clear anything.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filter]);

  /** Selection intersected with what's on screen — the only thing acted on. */
  const selectedWatches = useMemo<Watch[]>(
    () => visibleWatches.filter((w) => selectedIds.has(w.id)),
    [visibleWatches, selectedIds],
  );

  const onToggleSelect = useCallback((watch: Watch): void => {
    setSelectedIds((prev) => toggleOne(prev, watch.id));
  }, []);

  /** All-or-nothing for one group: partly-selected ticks the rest. */
  const onToggleGroupSelect = useCallback((watches: readonly Watch[]): void => {
    setSelectedIds((prev) => toggleGroup(prev, watches));
  }, []);

  const onSelectAll = useCallback((): void => {
    setSelectedIds(new Set(visibleWatches.map((w) => w.id)));
  }, [visibleWatches]);

  const onClearSelection = useCallback((): void => {
    setSelectedIds(new Set());
  }, []);

  const onToggleEditing = useCallback((): void => {
    setEditing((prev) => {
      if (prev) {
        setSelectedIds(new Set());
        setBulkName("");
      }
      return !prev;
    });
  }, []);

  /**
   * Delete every selected watch.
   *
   * Confirms only for a batch: the single-card path is instant (that friction
   * is the thing being removed), but a bulk delete is unbounded and there is
   * no undo — the rows are gone from the database, seats and all.
   */
  const onBulkDelete = useCallback(async (): Promise<void> => {
    const ids = selectedWatches.map((w) => w.id);
    if (ids.length === 0 || bulkBusy) return;
    if (
      ids.length > 1 &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete ${ids.length} watches permanently? This can’t be undone.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setBulkBusy("delete");
    // Applied even if a later chunk fails, so the list never claims a watch
    // still exists when it doesn't. `missing` ids are gone either way.
    const removed: string[] = [];
    try {
      for (const part of chunkIds(ids, MAX_BULK_WATCHES)) {
        await deleteWatches(part);
        removed.push(...part);
      }
    } catch (err) {
      setActionError(messageOf(err, "Couldn’t remove those watches."));
    } finally {
      forget(removed);
      setBulkBusy(null);
    }
  }, [selectedWatches, bulkBusy, forget]);

  /** Apply one label to every selected watch. Blank clears it. */
  const onBulkRename = useCallback(async (): Promise<void> => {
    const ids = selectedWatches.map((w) => w.id);
    if (ids.length === 0 || bulkBusy) return;
    setActionError(null);
    setBulkBusy("rename");
    const name = bulkName.trim() || null;
    const updated: Watch[] = [];
    try {
      for (const part of chunkIds(ids, MAX_BULK_WATCHES)) {
        const result = await renameWatches(part, name);
        updated.push(...result.updated);
      }
    } catch (err) {
      setActionError(messageOf(err, "Couldn’t rename those watches."));
    } finally {
      if (updated.length > 0) {
        const byId = new Map(updated.map((w) => [w.id, w]));
        setState((prev) =>
          prev.kind === "ready"
            ? {
                ...prev,
                watches: prev.watches.map((w) => byId.get(w.id) ?? w),
              }
            : prev,
        );
      }
      setBulkBusy(null);
    }
  }, [selectedWatches, bulkBusy, bulkName]);

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
          onDelete={onDelete}
          deleting={deletingIds.has(w.id)}
          onRename={onRename}
          renaming={renamingId === w.id}
          selectable={editing}
          selected={selectedIds.has(w.id)}
          onToggleSelect={onToggleSelect}
        />
      </li>
    ),
    [
      onDelete,
      deletingIds,
      onRename,
      renamingId,
      editing,
      selectedIds,
      onToggleSelect,
    ],
  );

  return (
    <>
      <DashboardHeader counts={counts} userEmail={userEmailOf(state)} />

      {state.kind === "ready" ? (
        <>
          <FilterTabs filter={filter} onChange={setFilter} counts={counts} />

          {/* Toolbar and bulk bar share one flex item so that the bar
              collapsing to zero height doesn't leave `.main`'s 32-48px gap
              behind it. The bar belongs to the toolbar anyway. */}
          {visibleWatches.length > 0 ? (
            <div className={styles.toolbarStack}>
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
                editing={editing}
                onToggleEditing={onToggleEditing}
              />

              {/* Always rendered, so the height has something to ease between —
                  the same 0fr → 1fr grid trick the group rows use. `.bulkWrapInner`
                  takes it out of the tab order once closed. */}
              <div
                className={`${styles.bulkWrap} ${editing ? styles.bulkWrapOpen : ""}`}
              >
                <div className={styles.bulkWrapInner}>
                  <BulkBar
                    selectedCount={selectedWatches.length}
                    visibleCount={visibleWatches.length}
                    name={bulkName}
                    onNameChange={setBulkName}
                    onSelectAll={onSelectAll}
                    onClear={onClearSelection}
                    onRename={() => void onBulkRename()}
                    onDelete={() => void onBulkDelete()}
                    busy={bulkBusy}
                    onDone={onToggleEditing}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {actionError ? (
            <div className={styles.banner} role="alert">
              <span className={styles.bannerTag}>Error</span>
              <span>{actionError}</span>
            </div>
          ) : null}

          {visibleWatches.length === 0 ? (
            <EmptyState filter={filter} hasAny={counts.total > 0} />
          ) : (
            <div className={styles.groups}>
              {groups.map((g) => (
                <WatchGroupCard
                  key={g.key}
                  group={g}
                  expanded={isOpen(g.key)}
                  onToggle={onToggleGroup}
                  renderWatch={renderWatch}
                  selectable={editing}
                  selectState={selectStateOf(g.watches, selectedIds)}
                  onToggleSelect={onToggleGroupSelect}
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
  counts: { active: number; expired: number; total: number };
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
          <span className={styles.tallyNum}>{counts.expired}</span>
          <span className={styles.tallyLabel}>Expired</span>
        </span>
        <span className={styles.tallyDot} aria-hidden="true" />
        <span className={styles.tallyItem}>
          <span className={styles.tallyNum}>{counts.total}</span>
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
  editing,
  onToggleEditing,
}: {
  groupBy: GroupBy;
  sortBy: SortBy;
  onGroupBy: (g: GroupBy) => void;
  onSortBy: (s: SortBy) => void;
  onToggleAll: () => void;
  allExpanded: boolean;
  showToggleAll: boolean;
  editing: boolean;
  onToggleEditing: () => void;
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

        <button
          type="button"
          className={`${styles.expandBtn} ${editing ? styles.expandBtnOn : ""}`}
          onClick={onToggleEditing}
          aria-pressed={editing}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>
    </div>
  );
}

// --- multi-select edit bar -----------------------------------------------

/**
 * The bar that appears under the toolbar in edit mode: select-all, one shared
 * name field, and the two bulk actions.
 *
 * The name field applies **one label to every selected watch**, overwriting
 * whatever they were called — which is the point. Four fan-out showings of one
 * film all becoming "Dad's birthday" is the case this exists for, and doing it
 * card by card was the tedium being removed.
 */
function BulkBar({
  selectedCount,
  visibleCount,
  name,
  onNameChange,
  onSelectAll,
  onClear,
  onRename,
  onDelete,
  busy,
  onDone,
}: {
  selectedCount: number;
  visibleCount: number;
  name: string;
  onNameChange: (v: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRename: () => void;
  onDelete: () => void;
  busy: "delete" | "rename" | null;
  onDone: () => void;
}): JSX.Element {
  const none = selectedCount === 0;
  const allPicked = selectedCount === visibleCount;
  const inputId = useId();

  return (
    <section className={styles.bulkBar} aria-label="Edit selected watches">
      <div className={styles.bulkTop}>
        <span className={styles.bulkTag}>Editing</span>
        <span className={styles.bulkCount}>
          {none
            ? "Nothing selected"
            : `${selectedCount} of ${visibleCount} selected`}
        </span>
        <button
          type="button"
          className={styles.bulkLink}
          onClick={allPicked ? onClear : onSelectAll}
          disabled={busy !== null}
        >
          {allPicked ? "Clear" : "Select all"}
        </button>
        <button
          type="button"
          className={`${styles.bulkLink} ${styles.bulkDone}`}
          onClick={onDone}
          disabled={busy !== null}
        >
          Done
        </button>
      </div>

      <div className={styles.bulkActions}>
        <label className={styles.bulkFieldLabel} htmlFor={inputId}>
          Name
        </label>
        <input
          id={inputId}
          className={styles.bulkInput}
          value={name}
          maxLength={120}
          placeholder={
            none ? "Select some cards first" : `Name all ${selectedCount}…`
          }
          disabled={none || busy !== null}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !none && busy === null) onRename();
          }}
        />
        <button
          type="button"
          className={styles.bulkApply}
          onClick={onRename}
          disabled={none || busy !== null}
          aria-busy={busy === "rename"}
        >
          {busy === "rename"
            ? "Applying…"
            : `Apply${none ? "" : ` to ${selectedCount}`}`}
        </button>
        <button
          type="button"
          className={styles.bulkDelete}
          onClick={onDelete}
          disabled={none || busy !== null}
          aria-busy={busy === "delete"}
        >
          {busy === "delete"
            ? "Deleting…"
            : `Delete${none ? "" : ` ${selectedCount}`}`}
        </button>
      </div>

      <p className={styles.bulkHint}>
        Leave the name blank and hit Apply to clear it — the cards fall back to
        the movie title. Deleting is permanent.
      </p>
    </section>
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
        {filter === "active"
          ? "Nothing you’re watching is still live."
          : "Nothing has expired yet."}
      </p>
      <p className={styles.emptyBody}>
        {filter === "active"
          ? "Check the Expired tab for the ones that have been and gone, or start a new watch from the homepage."
          : "Everything you’re watching is still live — see the Active tab."}
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
        {/* One per real tab, so the skeleton doesn't promise a row of five. */}
        {[0, 1].map((i) => (
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
