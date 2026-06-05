/**
 * Papercusp adapter for the generic generative `for_each` resolver (P-043 / D-012a).
 *
 * The fan-out algorithm itself — resolve a spec (items/glob/sql) to a deduped,
 * capped item-set; escalate over the cap or on failure — lives in the generic,
 * zero-coupling `@papercusp/fanout-resolver` lib. This adapter maps the
 * promote-policy WAVE shape onto that seam: a wave's resolver is `ForEachResolver`
 * (parsed/validated in `promote-policy`, where the deferred kind is keyed
 * `from_feature`), which this module translates to the generic `FanoutSpec` (where
 * the deferred kind is keyed `deferred`) before resolving. The glob/sql runners
 * are injected by the promote tool (`buildForEachCtx` — fast-glob over the harness
 * repo, a read-only SELECT against the harness PG).
 *
 * NOT YET (surfaced follow-up): the grep/AST resolver; the COMPLETION-TIME
 * resolver expanded when a producing feature publishes its items (see
 * `expand-generators.ts`); and edge-rewriting generated children into a dependent
 * wave's `blocked_by`.
 */
import { resolveFanout, isFanoutSpec, type FanoutSpec, type ResolveFanoutCtx } from '@papercusp/fanout-resolver';
import type { ForEachResolver } from './promote-policy';

/** True when a wave's `for_each` is a system-run resolver (object), not a legacy
 *  named string (resolved by the agent passing `generate_items`). */
export function isForEachResolver(forEach: string | ForEachResolver): forEach is ForEachResolver {
  return isFanoutSpec(forEach);
}

/**
 * True when a `for_each` resolver is COMPLETION-TIME (`from_feature`) — its
 * item-set is published by a producing feature's worker and is NOT known at
 * promote time, so the wave is deferred and expanded when that feature publishes
 * (D-019). The promote-time kinds (items/glob/sql) return false.
 */
export function isCompletionTimeForEach(
  forEach: string | ForEachResolver,
): forEach is { from_feature: string } {
  return isForEachResolver(forEach) && 'from_feature' in forEach;
}

/** Map the papercusp wave resolver (`from_feature`) onto the generic spec (`deferred`).
 *  The promote-time kinds (items/glob/sql) are already the generic shape. */
function toFanoutSpec(spec: ForEachResolver): FanoutSpec {
  return 'from_feature' in spec ? { deferred: spec.from_feature } : spec;
}

/**
 * Resolve a generative wave's item-set by running its resolver. Returns the
 * deduped, trimmed, non-empty items. Throws `FanoutCapError` over the cap and
 * `FanoutResolverError` on any resolver failure (including a `from_feature`
 * spec, which is completion-time and not resolvable here) — both signal
 * "escalate", never silent truncation/zero.
 */
export async function resolveForEach(
  spec: ForEachResolver,
  ctx: ResolveFanoutCtx = {},
): Promise<string[]> {
  return resolveFanout(toFanoutSpec(spec), ctx);
}
