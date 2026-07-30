/**
 * Selection algebra for the dashboard's multi-select edit mode.
 *
 * Pure and DOM-free, which is the point: a module that imports a CSS module
 * cannot be loaded outside a bundler, so anything worth checking without a
 * browser has to live here rather than inside `DashboardClient.tsx`. Same
 * reasoning as `lib/experienceTypes.ts` and `lib/watchSelection.ts`.
 *
 * Everything is keyed on `{ id }` rather than the full `Watch` type — these
 * rules genuinely don't care what else a watch has on it, and the looser type
 * keeps the module free of the `@/lib/api` import (and therefore of the path
 * alias a verification harness would otherwise have to resolve).
 */

/** How much of a group is ticked. */
export type SelectState = "none" | "some" | "all";

interface Identified {
  id: string;
}

/**
 * Tri-state for a group's checkbox.
 *
 * `"some"` is a real state, not a rounding of `"none"`: a row whose four cards
 * are half-ticked must not look untouched, or ticking it would silently
 * *deselect* the two that were already on.
 *
 * An empty group is `"none"` — there is nothing to have selected, and calling
 * it `"all"` (vacuously true) would render a ticked box over nothing.
 */
export function selectStateOf(
  items: readonly Identified[],
  selected: ReadonlySet<string>,
): SelectState {
  if (items.length === 0) return "none";
  let hits = 0;
  for (const item of items) {
    if (selected.has(item.id)) hits += 1;
  }
  if (hits === 0) return "none";
  return hits === items.length ? "all" : "some";
}

/**
 * Add or remove one id, always returning a new Set so React sees the change.
 */
export function toggleOne(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * All-or-nothing for one group: a fully-ticked group clears, anything else
 * fills. Following `selectStateOf`, a partly-ticked group *fills* — the user
 * who half-selected a row and then hit its checkbox meant "all of these".
 *
 * Ids outside the group are untouched, so ticking a movie row can never
 * disturb a selection made in another row.
 */
export function toggleGroup(
  selected: ReadonlySet<string>,
  items: readonly Identified[],
): Set<string> {
  const next = new Set(selected);
  if (items.length === 0) return next;
  const allOn = items.every((item) => next.has(item.id));
  for (const item of items) {
    if (allOn) {
      next.delete(item.id);
    } else {
      next.add(item.id);
    }
  }
  return next;
}

/**
 * Split ids into calls the backend will accept.
 *
 * `MAX_BULK_WATCHES` is a hard 422 on the server, so a user who selects more
 * than the cap has to be chunked rather than bounced. Exactly-`size` input must
 * stay a single call — an off-by-one here means an extra request per bulk
 * action, or an empty final chunk the server rejects for `min_length: 1`.
 */
export function chunkIds(ids: readonly string[], size: number): string[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}
