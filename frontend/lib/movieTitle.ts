/**
 * Movie-title identity — the rule behind grouping the watchlist by film.
 *
 * Cineplex decorates a title with its presentation format, so the same film
 * arrives under several names: "The Odyssey" and "The Odyssey: The IMAX
 * Experience® in 70MM Film" are one movie in two auditoriums. A watchlist that
 * grouped on the raw string would split them, which is exactly the clutter the
 * grouping exists to remove.
 *
 * Lives in `lib/` rather than inside a component so it can be exercised without
 * React or a CSS-module resolver — same reasoning as `lib/experienceTypes.ts`.
 */

/** A title reduced to its two useful forms. */
export interface CleanTitle {
  /**
   * Decoration stripped, casing and articles preserved — "The Odyssey".
   * This is what a group is labelled with.
   */
  clean: string;
  /**
   * The grouping identity: lowercased, article-less, and stripped of every
   * non-alphanumeric character *including spaces*. "Spider-Man", "Spiderman"
   * and "Spider Man" all reduce to `spiderman`, so the most common near-miss
   * needs no fuzzy matching at all.
   */
  key: string;
}

/**
 * Words that may appear in a trailing format decoration.
 *
 * A tail is only dropped when **every** word in it is in here, which is what
 * keeps "Dune: Part Two" intact — `part` and `two` are not format words. Bare
 * digits are deliberately absent for the same reason: "Dune: 2" is a sequel,
 * not a format.
 */
const FORMAT_WORDS: ReadonlySet<string> = new Set([
  // formats and brands
  "imax",
  "ultraavx",
  "avx",
  "dbox",
  "atmos",
  "dolby",
  "screenx",
  "4dx",
  "3d",
  "2d",
  "vip",
  "laser",
  "70mm",
  "35mm",
  "mm",
  "hfr",
  "uhd",
  "cinema",
  "xtremerealx",
  "realx",
  "prime",
  "recliner",
  // filler that glues a decoration together
  "the",
  "a",
  "an",
  "in",
  "and",
  "with",
  "on",
  "at",
  "of",
  "film",
  "films",
  "experience",
  "experiences",
  "presentation",
  "presented",
  "version",
  "edition",
  "format",
  "screen",
  "screening",
  "seating",
  "sound",
  "audio",
  "premium",
  "plus",
  // accessibility / language variants Cineplex appends the same way
  "subtitled",
  "subtitles",
  "dubbed",
  "closed",
  "captioned",
  "captions",
  "open",
  "descriptive",
]);

/** Leading articles dropped from the key so "The Odyssey" == "Odyssey". */
const LEADING_ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

/**
 * Two keys this far apart (or closer) are treated as the same film.
 *
 * Exported so the threshold is one edit away from being retuned. Raising it is
 * risky: normalization already collapses the punctuation and spacing cases, so
 * everything this catches is a genuine typo.
 */
export const NEAR_MATCH_MAX_DISTANCE = 1;

/**
 * Both keys must be at least this long before a near match is considered.
 *
 * Short titles are where a single edit is most likely to be a different film —
 * "Dune"/"Dunes", "It"/"In" — so they are held to exact matching.
 */
export const NEAR_MATCH_MIN_LEN = 8;

/**
 * Strip trademark marks and diacritics so "Pokémon®" and "Pokemon" agree.
 *
 * The combining range is written as escapes rather than literal characters:
 * U+0300–U+036F are *combining* marks, so as literals they render attached to
 * the preceding bracket and survive an encoding round-trip only by luck.
 */
function stripMarks(value: string): string {
  return value
    .replace(/[®™©]/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** One word reduced to bare alphanumerics: "D-BOX" -> "dbox", "70MM" -> "70mm". */
function wordKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Build the vocabulary for one title: the static list plus the showtime's own
 * format tokens.
 *
 * Feeding `experience_types` in is what makes this self-adjusting — a format
 * Cineplex invents next year strips correctly the moment it appears in the
 * metadata, without a code change. Each token contributes both its whole
 * normalized form ("Dolby Atmos" -> `dolbyatmos`) and its individual words, so
 * it matches however the title happens to space it.
 */
function vocabularyFor(experienceTypes: readonly string[]): ReadonlySet<string> {
  if (experienceTypes.length === 0) return FORMAT_WORDS;
  const vocab = new Set(FORMAT_WORDS);
  for (const raw of experienceTypes) {
    if (typeof raw !== "string") continue;
    const whole = wordKey(raw);
    if (whole) vocab.add(whole);
    for (const part of raw.split(/\s+/)) {
      const word = wordKey(part);
      if (word) vocab.add(word);
    }
  }
  return vocab;
}

/** True when every word in `tail` is format vocabulary (and there is at least one). */
function isFormatTail(tail: string, vocab: ReadonlySet<string>): boolean {
  const words = tail
    .split(/\s+/)
    .map(wordKey)
    .filter((w) => w.length > 0);
  if (words.length === 0) return false;
  return words.every((w) => vocab.has(w));
}

/**
 * Where a decoration can begin. Scanned from the **right**, repeatedly, because
 * a title can carry more than one: "The Odyssey: The IMAX Experience in 70MM
 * Film" sheds " in 70MM Film" first and ": The IMAX Experience" second.
 *
 * Working right-to-left is also what saves "Spider-Man: Brand New Day in
 * UltraAVX" — the leftmost boundary (`:`) opens a tail that is *not* all format
 * words, so a single left-most split would have kept the "in UltraAVX" suffix.
 */
const BOUNDARIES: readonly string[] = [":", " - ", " – ", " — ", " in ", "(", "["];

/** Index of the right-most boundary, and how many characters it occupies. */
function lastBoundary(
  value: string,
): { index: number; length: number } | null {
  const haystack = value.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const token of BOUNDARIES) {
    const index = haystack.lastIndexOf(token);
    if (index <= 0) continue; // index 0 would leave an empty head
    if (best === null || index > best.index) {
      // A bracket is itself part of the tail; a separator is not.
      const length = token === "(" || token === "[" ? 0 : token.length;
      best = { index, length };
    }
  }
  return best;
}

/**
 * Reduce a displayed title to its film identity.
 *
 * @param title           What the user sees — their own watch name if they set
 *                        one, otherwise the resolved Cineplex movie name.
 * @param experienceTypes The showtime's raw format tokens, used to widen the
 *                        strip vocabulary. Safe to omit.
 */
export function cleanMovieTitle(
  title: string,
  experienceTypes: readonly string[] = [],
): CleanTitle {
  const vocab = vocabularyFor(experienceTypes);
  let head = collapse(stripMarks(title));

  // Shed trailing decorations until one refuses to be format vocabulary.
  for (;;) {
    const boundary = lastBoundary(head);
    if (boundary === null) break;
    const tail = head
      .slice(boundary.index + boundary.length)
      .replace(/[)\]]+\s*$/, "");
    if (!isFormatTail(tail, vocab)) break;
    const next = collapse(head.slice(0, boundary.index)).replace(
      /[:\-–—,\s]+$/,
      "",
    );
    // Never strip a title down to nothing: a film genuinely called "IMAX"
    // keeps its name.
    if (next.length === 0) break;
    head = next;
  }

  const clean = collapse(head).replace(/[:\-–—,\s]+$/, "");

  let key = clean.toLowerCase();
  const firstSpace = key.indexOf(" ");
  if (firstSpace > 0 && LEADING_ARTICLES.has(key.slice(0, firstSpace))) {
    key = key.slice(firstSpace + 1);
  }
  key = key.replace(/[^a-z0-9]/g, "");

  return { clean, key };
}

/** Every digit in the key, in order — "deadpool2" -> "2", "dune" -> "". */
function digitSignature(value: string): string {
  return value.replace(/\D/g, "");
}

/** Levenshtein distance, answered as a yes/no so the DP can bail out early. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Every remaining row can only grow this minimum, so we are already out.
    if (rowMin > max) return false;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return (prev[b.length] as number) <= max;
}

/**
 * Whether two normalized keys are close enough to be the same film.
 *
 * The digit guard is the one that matters: `deadpool2` and `deadpool3` are a
 * single edit apart and comfortably over the length floor, so without it every
 * numbered sequel would silently collapse into its predecessor.
 *
 * Roman-numeral sequels ("…partii" / "…partiii") are *not* guarded this way and
 * could merge. The escape hatch is the existing rename — a watch groups under
 * whatever the user calls it.
 */
export function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < NEAR_MATCH_MIN_LEN || b.length < NEAR_MATCH_MIN_LEN) {
    return false;
  }
  if (Math.abs(a.length - b.length) > 1) return false;
  if (digitSignature(a) !== digitSignature(b)) return false;
  return withinDistance(a, b, NEAR_MATCH_MAX_DISTANCE);
}

/**
 * Collapse near-identical keys onto one canonical key each.
 *
 * Union-find rather than pairwise comparison so merging is **transitive** — if
 * A matches B and B matches C, all three land in one group even when A and C
 * are two edits apart. Roots are chosen lexicographically and the input is
 * sorted first, so the result never depends on the order watches arrived in.
 *
 * @returns every input key mapped to its canonical key (identity when unmerged).
 */
export function unionNearMatches(
  keys: Iterable<string>,
): Map<string, string> {
  const unique = [...new Set(keys)].filter((k) => k.length > 0).sort();
  const parent = new Map<string, string>();
  for (const key of unique) parent.set(key, key);

  function find(key: string): string {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Path compression — keeps repeated lookups flat.
    let cursor = key;
    while (cursor !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const a = unique[i] as string;
      const b = unique[j] as string;
      if (!isNearMatch(a, b)) continue;
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) continue;
      // Smaller string wins so the canonical key is stable.
      if (rootA < rootB) parent.set(rootB, rootA);
      else parent.set(rootA, rootB);
    }
  }

  const canonical = new Map<string, string>();
  for (const key of unique) canonical.set(key, find(key));
  return canonical;
}
