/**
 * risk-tiers.ts — the graded risk-tier vocabulary for the Queen autonomy gate
 * (queen-autonomy-policy-2026-06-13).
 *
 * The autonomy model composes THREE orthogonal axes — risk · reversibility ·
 * authority (D-002). THIS module owns the **risk** axis vocabulary: a graded
 * `risk_tier` (D-001) where the old binary `needs-human` is just the top band,
 * *derived* (an item whose tier exceeds the effective per-category ceiling),
 * never a stored token.
 *
 * ── Two related scales ──────────────────────────────────────────────────────
 *  • {@link RISK_TIERS} — the 5 tiers an ACTION/item carries (trivial..critical,
 *    rank 1..5). B-01 (4605e) adds the `risk_tier` column to items/escalations
 *    using exactly these values — this is a SHARED SEAM: import `RISK_TIERS`
 *    from here, do not redeclare the enum.
 *  • {@link CEILING_LEVELS} — the per-category ceiling the OWNER sets: the 5
 *    tiers PLUS a `none` band (rank 0) meaning never-auto. `none` is the
 *    behavior-neutral shipped default (D-007): with the ceiling at `none`, no
 *    item tier (≥ trivial) is ever ≤ the ceiling, so nothing auto-runs.
 *
 * The gate (D-004):
 *   auto ⟺ risk_tier(item) ≤ min(category_ceiling, graduated_level)
 *          ∧ reversible ∧ ¬authority_owner ∧ ¬protected
 * THIS module supplies the `risk_tier(item) ≤ ceiling` comparison primitives;
 * reversibility (B-02), authority (B-01) and protected (categories.ts) live in
 * their own modules.
 *
 * `risk_tier` is DISTINCT from `importance` (P-014): the ranker consumes
 * importance (what to do first); the autonomy gate consumes risk (whether to
 * auto-decide). Keep them apart.
 *
 * Pure data + pure functions — no DB, no IO.
 */

/** The 5 graded risk tiers an action/item carries, ascending (rank 1..5). */
export const RISK_TIERS = ['trivial', 'low', 'moderate', 'high', 'critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * The per-category ceiling vocabulary: the 5 risk tiers plus `none` (rank 0),
 * the never-auto floor. A ceiling of `none` auto-decides nothing (the D-007
 * behavior-neutral default); a ceiling of `critical` would auto-decide every
 * tier (subject to the reversibility/authority/protected hard gates).
 */
export const CEILING_LEVELS = ['none', ...RISK_TIERS] as const;
export type CeilingLevel = (typeof CEILING_LEVELS)[number];

const RANK: Readonly<Record<CeilingLevel, number>> = {
  none: 0,
  trivial: 1,
  low: 2,
  moderate: 3,
  high: 4,
  critical: 5,
};

/** Numeric rank of a tier/level (none=0 … critical=5). */
export function riskRank(level: CeilingLevel): number {
  return RANK[level];
}

/** Type guard: is `s` one of the 5 item risk tiers (trivial..critical)? */
export function isRiskTier(s: string): s is RiskTier {
  return (RISK_TIERS as readonly string[]).includes(s);
}

/** Type guard: is `s` a ceiling level (none + the 5 tiers)? */
export function isCeilingLevel(s: string): s is CeilingLevel {
  return (CEILING_LEVELS as readonly string[]).includes(s);
}

/** Compare two levels by rank: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareRisk(a: CeilingLevel, b: CeilingLevel): number {
  return RANK[a] - RANK[b];
}

/** The lower-autonomy (smaller-rank) of two ceiling levels — the gate's `min`. */
export function minCeiling(a: CeilingLevel, b: CeilingLevel): CeilingLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * Is an item of `itemTier` at or below `ceiling` — i.e. inside the auto-decide
 * band? A `none` ceiling ⇒ always false (never-auto, since every item tier is
 * ≥ trivial). This is the `risk_tier(item) ≤ ceiling` half of the D-004 gate;
 * the hard gates (reversible / authority / protected) are applied by the caller.
 */
export function withinCeiling(itemTier: RiskTier, ceiling: CeilingLevel): boolean {
  return RANK[itemTier] <= RANK[ceiling];
}
