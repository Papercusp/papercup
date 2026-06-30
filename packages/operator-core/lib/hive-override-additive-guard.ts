/**
 * hive-override-additive-guard.ts — a LIGHT, warn-only check that a hive instance
 * prompt override stays ADDITIVE (owner directive 2026-06-24).
 *
 * A hive's `promptOverride.<role>` is APPENDED after the generated blueprint persona; it
 * must only ADD hive-specifics, never re-state what the generated base/chain already
 * provides. A wholesale snapshot that copies the base (the bug that froze a stale `## AUTO
 * mode` into papercusp/promptOverride.su) silently duplicates content + drifts from the
 * generated source. This detects the clearest "you copied the base" signals and returns
 * them so the write path can WARN (non-blocking — overrides are the owner's to author; we
 * surface the smell, we don't gate it).
 *
 * Heuristic, not exhaustive: it keys on stable, base-OWNED section headings + the generated
 * splice markers — content that lives in the generated chain and therefore should never be
 * re-stated in an additive override. Cheap (pure string scan); no prompt-resolve needed.
 */

/** Stable section headings the GENERATED su base / its splices own — an override that
 *  re-states one is duplicating, not adding. (Substring match on a `## ` heading line.) */
const BASE_OWNED_HEADINGS: readonly string[] = [
  'AUTO mode', // generated via PAPERCUSP-SU:AUTO-MODE (operating-modes-policy.ts)
  'IDEATE mode', // generated via PAPERCUSP-SU:AUTO-MODE (operating-modes-policy.ts) — same section
  'Who you are',
  'Working in a shared environment',
  'Git — a background routine owns commit',
  'Engineering discipline',
  'Coordination glyph legend',
  'Wire schemas',
];

/** Generated splice markers — never belong in an override (they're the base's seams). */
const GENERATED_MARKER = 'PAPERCUSP-SU:';

export interface AdditiveOverlap {
  /** Base-owned section headings the override appears to re-state. */
  headings: string[];
  /** Whether the override embeds a generated splice marker. */
  hasGeneratedMarker: boolean;
}

/**
 * Scan an override's markdown for content the generated base already supplies.
 * Returns the overlap; empty headings + no marker ⇒ the override looks purely additive.
 */
export function detectGeneratedBaseOverlap(md: string): AdditiveOverlap {
  const headingLines = md
    .split('\n')
    .filter((l) => /^#{1,3}\s/.test(l.trim()))
    .map((l) => l.trim());
  const headings = BASE_OWNED_HEADINGS.filter((owned) =>
    headingLines.some((h) => h.toLowerCase().includes(owned.toLowerCase())),
  );
  return { headings, hasGeneratedMarker: md.includes(GENERATED_MARKER) };
}

/**
 * A human-readable warning when an override duplicates generated content, or null when it
 * looks additive. Used by the override write path to surface the smell (non-blocking).
 */
export function additiveOverrideWarning(md: string): string | null {
  const { headings, hasGeneratedMarker } = detectGeneratedBaseOverlap(md);
  if (headings.length === 0 && !hasGeneratedMarker) return null;
  const parts: string[] = [];
  if (headings.length > 0) {
    parts.push(`re-states generated-base section(s): ${headings.join(', ')}`);
  }
  if (hasGeneratedMarker) parts.push(`embeds a generated splice marker (${GENERATED_MARKER}…)`);
  return (
    `This override ${parts.join('; ')}. Hive overrides should be ADDITIVE — only the ` +
    `hive-specific delta — because they are APPENDED after the generated blueprint persona, ` +
    `which already supplies that content. Duplicating it shadows the generated source and ` +
    `goes stale (see the papercusp/promptOverride.su wholesale-snapshot fix, 2026-06-24).`
  );
}
