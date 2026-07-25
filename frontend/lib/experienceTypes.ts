/**
 * Presentation-format token handling — the suppression rule behind
 * `app/components/ExperienceBadges.tsx`.
 *
 * Lives in `lib/` rather than inside the component so it can be exercised
 * without React or a CSS-module resolver.
 */

/** Collapse whitespace and case so the comparison is about tokens, not spacing. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Drops every format token the title already states, keeping the rest in
 * upstream order (and de-duplicated).
 *
 * The comparison is against the *displayed* title, not `movie_name`, on
 * purpose: "The Odyssey: The IMAX Experience® in 70MM Film" already says both
 * of its tokens, so it renders nothing — but rename that watch to "Dad's
 * birthday" and the format is no longer stated anywhere, so the badges
 * reappear. That is the correct outcome, and it costs no extra logic.
 *
 * Only the comparison is case-insensitive; surviving tokens are returned
 * verbatim because the casing is Cineplex's own branding ("70mm", not "70MM").
 */
export function filterExperienceTypes(
  types: string[],
  title: string,
): string[] {
  const haystack = normalize(title);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of types) {
    const token = raw.trim();
    if (!token) continue;
    const key = normalize(token);
    if (seen.has(key)) continue;
    if (haystack.includes(key)) continue;
    seen.add(key);
    kept.push(token);
  }
  return kept;
}
