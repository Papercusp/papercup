/**
 * @module autonomy — the Queen-autonomy CATEGORY taxonomy + action-surface audit
 * (queen-autonomy-policy-2026-06-13 B-04: P-015 audit · P-016 coverage · P-020
 * taxonomy encoding + capability→category map).
 *
 * This is the behavior-neutral FOUNDATION the rest of the plan builds on — pure
 * data + pure functions, no DB, no gate, nothing armed:
 *   • {@link ./categories}             — the canonical 13-category taxonomy (the
 *                                         shared seam B-03's store seeds + keys on).
 *   • {@link ./capability-category-map}— resolve a tool/verb → its category
 *                                         (fail-safe `null` → never-auto).
 *   • {@link ./action-surface}         — the authoritative human-driving action
 *                                         inventory + coverage verdicts.
 *
 * The gate that CONSUMES this (B-12), the policy STORE keyed on it (B-03), and the
 * arming gate (P-092) are elsewhere. Importing from here arms nothing.
 */

export {
  type AutonomyCategory,
  type CategoryDef,
  type SuggestedPosture,
  CATEGORIES,
  AUTONOMY_CATEGORY_IDS,
  PROTECTED_CATEGORIES,
  isAutonomyCategory,
  getCategory,
  isProtectedCategory,
} from './categories';

export {
  type CategoryResult,
  classifyActionCategory,
  categoryForAction,
  categoryMapRules,
} from './capability-category-map';

export {
  type Authority,
  type Coverage,
  type HumanDrivingAction,
  ACTION_SURFACE,
  coverageGaps,
  partialCoverage,
  categoriesInAudit,
} from './action-surface';
