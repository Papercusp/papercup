/**
 * cup-fresh-context-delta — the P-006 three-regime cost comparison
 * (bee-context-efficiency-2026-06-14 Phase 1; D-001, D-011, D-016, D-021).
 *
 * P-006 asks: measure the latency/cost delta of (a) fresh-context warm-inject re-invoke
 * vs (b) a cold fresh-spawn vs (c) the legacy `--resume` transcript-carry — and keep the
 * warm-process benefit only where it is real, else collapse to fresh-spawn.
 *
 * THE THREE REGIMES, per the measured baselines:
 *   (c) LEGACY `--resume`  = the per-spawn injected baseline + the CARRY: the whole grown
 *       prior-task transcript re-read every turn (D-011: ~138K tokens/turn, 97.4% of a
 *       long cup's prompt; D-016: avg 2.84M carry on a long-lived cup, max 21.3M).
 *   (a) FRESH-CONTEXT      = a fresh spawn that REUSES the cup's work-item claim: fresh
 *       session + full preamble + the hydration tail, NO prior-task carry. Cost = the
 *       per-spawn injected baseline (D-016: avg ~77-92K cache_creation, mostly the
 *       cross-cup-shared cacheable preamble), ~no carry.
 *   (b) COLD FRESH-SPAWN   = the SAME per-spawn injected baseline. The cup process is
 *       ALWAYS exited between warm-inject tasks (wake-executor PARKs live sessions; only
 *       an exited one is resumed — D-021), so there is NO live warm process for (a) to
 *       preserve over (b): fresh-context IS a cold spawn that reuses the identity/claim.
 *
 * CONCLUSION (D-021): the warm-process benefit is ZERO a-priori ⇒ (a) ≡ (b); both beat
 * (c) by the entire carry. So P-005 collapses to D-001 (b): a NEW-task warm-inject of a
 * drained cup → fresh spawn. This module makes the per-task delta computable/observable
 * (D-006 "observable, not asserted") from the live telemetry (cupWakeEfficiency +
 * the per-spawn cache_creation baseline). PURE — unit-tests with no DB.
 */

export interface FreshContextRegimeDelta {
  /** Per-task tokens the LEGACY `--resume` regime re-reads on top of the spawn baseline —
   *  the carry (avgCarriedPerWarmInject). 0 when no warm-inject was observed. */
  legacyCarryPerTaskTokens: number;
  /** The fresh-context / cold-spawn per-task injected baseline (≈ the cacheable preamble +
   *  a small volatile tail; D-016). Both regimes (a)/(b) pay this. */
  freshSpawnBaselineTokens: number;
  /** Per-task tokens AVOIDED by fresh-context vs legacy `--resume` (= the carry dropped). */
  savedPerTaskTokens: number;
  /** Carry as a share of the legacy per-task prompt (baseline + carry) — the fraction of
   *  the legacy prompt that was dead prior-task transcript. 0..1; 0 when no data. */
  carryShareOfLegacy: number;
  /** Does reusing the warm process beat a cold spawn? Always false: the cup process is
   *  exited between tasks, so fresh-context IS a cold spawn (D-021) ⇒ collapse to (b). */
  warmProcessBenefit: false;
  /** The faithful D-001 resolution given the above: always 'collapse-to-fresh-spawn'. */
  recommendation: 'collapse-to-fresh-spawn';
}

/**
 * Compute the three-regime per-task delta from the live cup telemetry. `avgCarriedPerWarmInject`
 * is `cupWakeEfficiency().avgCarriedPerWarmInject` (the measured carry per warm-inject, null
 * when no cup warm-injected); `freshSpawnBaselineTokens` is the per-spawn injected baseline
 * (avg `cache_creation` over recent cup spawns — D-016 ≈ 77-92K). Both clamp to ≥0.
 */
export function freshContextRegimeDelta(input: {
  avgCarriedPerWarmInject: number | null;
  freshSpawnBaselineTokens: number;
}): FreshContextRegimeDelta {
  const carry = Math.max(0, input.avgCarriedPerWarmInject ?? 0);
  const baseline = Math.max(0, input.freshSpawnBaselineTokens);
  const legacyPerTask = baseline + carry;
  return {
    legacyCarryPerTaskTokens: carry,
    freshSpawnBaselineTokens: baseline,
    savedPerTaskTokens: carry, // fresh-context drops exactly the carry
    carryShareOfLegacy: legacyPerTask > 0 ? carry / legacyPerTask : 0,
    warmProcessBenefit: false,
    recommendation: 'collapse-to-fresh-spawn',
  };
}
