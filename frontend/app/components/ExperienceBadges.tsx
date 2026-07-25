import { filterExperienceTypes } from "@/lib/experienceTypes";
import styles from "./ExperienceBadges.module.css";

interface Props {
  /**
   * Cineplex's own format tokens for the screening, e.g. `["IMAX", "70mm"]`.
   * Rendered verbatim — the casing is their branding.
   */
  types: string[];
  /**
   * The title currently displayed next to these badges. Any token the title
   * already states is dropped — see `lib/experienceTypes.ts` for why the
   * comparison uses the displayed title rather than the movie name.
   */
  title: string;
  /** Show at most this many, then a `+N` chip. Omit for no cap. */
  max?: number;
}

/**
 * Presentation-format chips (IMAX / 70mm / UltraAVX / Dolby Atmos / 3D) that sit
 * beside a showtime's title, theatre and time.
 *
 * Renders `null` — no DOM at all — when nothing survives the suppression rule,
 * which is the common case for premium-format releases whose titles already
 * spell the format out.
 *
 * Styled as a filled brass stamp — the only filled-brass element in the app,
 * which is what keeps it from reading as another seat chip. See the note at the
 * top of the stylesheet on why this knowingly bends the "brass stays rare" rule.
 *
 * Badges belong only next to the title they are de-duplicated against (the
 * watch-page header and the dashboard card). Repeating them elsewhere on the
 * same screen is exactly the clutter the suppression rule exists to avoid.
 */
export function ExperienceBadges({
  types,
  title,
  max,
}: Props): JSX.Element | null {
  const kept = filterExperienceTypes(types, title);
  if (kept.length === 0) return null;

  const shown = max !== undefined ? kept.slice(0, max) : kept;
  const hidden = kept.length - shown.length;

  return (
    <ul className={styles.list} aria-label="Presentation formats">
      {shown.map((token) => (
        <li key={token} className={styles.badge}>
          {token}
        </li>
      ))}
      {hidden > 0 ? (
        <li
          className={`${styles.badge} ${styles.badgeMore}`}
          title={kept.slice(shown.length).join(" · ")}
        >
          +{hidden}
        </li>
      ) : null}
    </ul>
  );
}
