/**
 * retired-tier-roles.ts — WHICH agent roles belong to the retired Mug/Kettle/Cup
 * tier (retire-mug-kettle-su-only-2026-08-09 P-008 / D-018).
 *
 * Split out as its own module for two deliberate reasons:
 *
 *  1. ONE definition, TWO chokepoints. The spawn surface has exactly two doors —
 *     `fleet/operator-spawn.ts` (the role-admission chokepoint every agent-driven
 *     launch funnels through) and `endpoint-route/routes/harness/spawn.ts` (the
 *     `/invoke` route every launch-blueprint + wake path traverses). Both must
 *     answer this question identically; two inline literal lists would be two
 *     things free to drift, and a drifted spawn gate fails OPEN.
 *
 *  2. NOT added to `pot/started.ts`. That module already exports
 *     `mugKettleSystemEnabled`, and adding an export there strands every
 *     `vi.mock('.../pot/started')` factory in the tree — measured twice on this
 *     plan (EI-20017608270017874), once loudly and once SILENTLY. A new module
 *     nobody mocks yet carries none of that blast radius.
 *
 * ⚠ CANONICALIZE BEFORE TESTING — this is the whole subtlety. The pot rename left
 * live ALIASES in `coordination/roles.ts` (`bee`→`cup`, `queen`→`mug`,
 * `overwatch`→`kettle`), and real callers still use the old spellings: the
 * `/invoke` route's own comment records `?role=queen` as the PRODUCTION
 * convention for Mug wakes. Matching the raw string would leave all three roles
 * reachable under their former names — a gate that looks closed and is open,
 * which is the "anchor to the property, not the spelling" failure this plan has
 * now hit at three separate layers.
 *
 * ⚠ `scout` ALSO maps through that table (→ `blender`) and is deliberately NOT
 * here: D-001 keeps Scout/Blender INTACT. Adding it would retire the subsystem
 * the replacement plan depends on.
 */
import { canonicalCoordRole } from '../agent-tools/coordination/roles';

/**
 * The CANONICAL role ids of the retired tier (D-001: Mug, Kettle, and the
 * Cup/nursery tier). Canonical spellings only — aliases are resolved by
 * `isRetiredTierRole`, never listed here, so this set stays the single statement
 * of WHAT is retired rather than a list of spellings to keep chasing.
 */
export const RETIRED_TIER_ROLES: ReadonlySet<string> = new Set(['mug', 'kettle', 'cup']);

/**
 * Does `role` name an agent of the retired Mug/Kettle/Cup tier — under EITHER
 * its current or its pre-rename spelling?
 *
 * Note this answers only "is this role in the retired tier", NOT "should this be
 * refused" — the caller pairs it with `mugKettleSystemEnabled()`, so the tier
 * stays spawnable while the flag is ON (it is a `case: 'cutover'` flag, and
 * reversibility is the point).
 */
export function isRetiredTierRole(role: string): boolean {
  return RETIRED_TIER_ROLES.has(canonicalCoordRole(role));
}
