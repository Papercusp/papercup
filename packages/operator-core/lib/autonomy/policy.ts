/**
 * policy.ts — the per-category autonomy policy value type + the pure gate
 * arithmetic over it (queen-autonomy-policy-2026-06-13 B-03 / Phase 2).
 *
 * THIS module owns the risk-axis COMPOSITION: given a category's stored policy
 * row, compute its EFFECTIVE ceiling — the actual auto-decide cap after applying
 * the lock + the graduation cap. The DB access lives in {@link ./policy-store};
 * the category taxonomy in {@link ./categories} (B-04); the risk vocabulary in
 * {@link ./risk-tiers}. Pure — no DB, no IO.
 *
 * The gate (D-004): auto ⟺ risk_tier(item) ≤ effectiveCeiling(category)
 * ∧ reversible ∧ ¬authority_owner. `effectiveCeiling` folds the per-category
 * controls (lock, owner ceiling, graduation) into ONE level; the orthogonal hard
 * gates (reversibility B-02, authority B-01) are applied by the decider (B-12),
 * not here.
 */
import { type AutonomyCategory, isProtectedCategory } from './categories';
import { type CeilingLevel, minCeiling, riskRank } from './risk-tiers';

/**
 * One category's autonomy policy — the value shape of a
 * `harness_shared.autonomy_policy` row (B-03 / P-021), minus the storage
 * bookkeeping (workspace_id / updated_by / updated_at).
 */
export interface AutonomyCategoryPolicy {
  category: AutonomyCategory;
  /** Owner-set risk ceiling (the cap; D-003). `none` = never-auto. */
  ceiling: CeilingLevel;
  /**
   * Never-auto regardless of ceiling/graduation (D-005). Protected categories
   * ship `true`; the gate treats `locked` as an effective ceiling of `none`.
   */
  locked: boolean;
  /**
   * The graduation engine's earned level (B-16 / D-005). Moves only WITHIN the
   * owner ceiling — never raises autonomy above `ceiling` (the store clamps it).
   * Defaults to `none`.
   */
  graduatedLevel: CeilingLevel;
  /** Per-class threshold overrides (forward slot for B-16). Default `{}`. */
  thresholdOverrides: Record<string, unknown>;
  /**
   * Owner's explicit override directive, or null. When `{ pinned: true }` the
   * graduation engine (B-16) must not move `graduatedLevel`. Stored verbatim by
   * B-03; honored by B-16. Null = governed by ceiling + graduation.
   */
  ownerOverride: Record<string, unknown> | null;
}

/**
 * The EFFECTIVE auto-decide ceiling for a category — D-004's
 * `min(category_ceiling, graduated_level)`, with `locked` as a hard floor:
 *   - `locked`  ⇒ `none` (never-auto; protected, or owner-locked)
 *   - otherwise ⇒ `min(ceiling, graduatedLevel)`
 *
 * `graduatedLevel` can never exceed `ceiling` (the store clamps on write), so the
 * `min` is defensive. Returns the level at or below which an item auto-decides —
 * still subject to the reversibility/authority hard gates applied elsewhere.
 */
export function effectiveCeiling(p: AutonomyCategoryPolicy): CeilingLevel {
  if (p.locked) return 'none';
  return minCeiling(p.ceiling, p.graduatedLevel);
}

/** Is auto-decide ever possible for this category right now? (effective > none) */
export function autoEverAllowed(p: AutonomyCategoryPolicy): boolean {
  return riskRank(effectiveCeiling(p)) > 0;
}

/**
 * The behavior-neutral DEFAULT policy for a category (D-007): ceiling `none`
 * (never-auto), graduation `none`, and `locked` iff the category is protected
 * (D-005). This is the value the store returns for any category with no stored
 * row — so every workspace is never-auto by default without a per-workspace seed
 * (the fail-safe: a missing/unknown category never auto-decides).
 */
export function defaultPolicyFor(category: AutonomyCategory): AutonomyCategoryPolicy {
  return {
    category,
    ceiling: 'none',
    locked: isProtectedCategory(category),
    graduatedLevel: 'none',
    thresholdOverrides: {},
    ownerOverride: null,
  };
}
