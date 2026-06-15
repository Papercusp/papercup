/**
 * bet-flag-reverter.ts — wire the bake-off regression gate to the queen-autonomy
 * revert-executor (plan-implementation-framework-2026-06-15 P-012, activation of P-009).
 *
 * When the continuous bake-off (P-007) finds a bet REGRESSED (regression-gate.ts
 * decideRollout → action:'revert'), the bet's flag is auto-reverted OFF through the existing
 * tripwire revert dispatch (B-16): a `{ kind:'flag-override', key }` RevertHandle, dispatched by
 * executeRevertVia to the reverter registered here. The reverter ONLY ever sets a flag OFF
 * (false) — never on (default-on stays the OWNER's gate, D-005). Self-contained: it closes over
 * its own off-only op and ignores the shared RevertHelpers, so it adds a handle kind WITHOUT
 * modifying the core revert-executor or its RevertHelpers contract.
 *
 * ACTIVATION (documented, not built): register it on the live tripwire sweep's registry, and
 * have the bake-off arm a tripwire carrying betFlagRevertHandle(flagKey) on a regressed verdict.
 */
import type { RevertHandle } from '../autonomy/tripwire/core';
import type { RevertOutcome } from '../autonomy/tripwire/scan';
import { registerReverter, type Reverter } from '../autonomy/tripwire/revert-executor';
import type { FlagKey } from '@papercusp/flags';
import type { RolloutDecision } from './regression-gate';

/** The revert-handle kind for a bet-flag auto-revert. */
export const BET_FLAG_REVERT_KIND = 'flag-override';

/** The RevertHandle that reverts a bet flag off. */
export function betFlagRevertHandle(flagKey: string): RevertHandle {
  return { kind: BET_FLAG_REVERT_KIND, key: flagKey };
}

/** Map a rollout decision to a revert handle — ONLY a 'revert' decision produces one. Pure. */
export function revertHandleForRollout(decision: RolloutDecision, flagKey: string): RevertHandle | null {
  return decision.action === 'revert' ? betFlagRevertHandle(flagKey) : null;
}

/** Build the bet-flag reverter from an injected OFF-only op (testable). Never enables a flag. */
export function makeBetFlagReverter(setFlagOff: (key: string) => Promise<unknown>): Reverter {
  return async (handle: RevertHandle): Promise<RevertOutcome> => {
    const key = typeof handle.key === 'string' && handle.key ? handle.key : null;
    if (!key) return { reverted: false, note: 'flag-override handle missing key' };
    // OFF only — auto-revert never enables a flag; default-on is the owner gate (D-005). A thrown
    // op is caught by executeRevertVia → reverted:false (the built-in reverters rely on that too).
    await setFlagOff(key);
    return { reverted: true, note: `bet flag '${key}' auto-reverted off (bake-off regression)` };
  };
}

/** The live reverter, binding setFlagOverride(key,false) (lazy import so this leaf stays light). */
export function defaultBetFlagReverter(): Reverter {
  return makeBetFlagReverter(async (key) => {
    const { setFlagOverride } = await import('@papercusp/flags/server');
    const r = await setFlagOverride(key as FlagKey, false);
    if (!r.ok) throw new Error(`setFlagOverride(${key}=false) failed: ${r.reason}`);
  });
}

/** Register the bet-flag reverter on a tripwire revert registry (extends; never overrides built-ins). */
export function registerBetFlagReverter(registry: Map<string, Reverter>): void {
  registerReverter(registry, BET_FLAG_REVERT_KIND, defaultBetFlagReverter());
}
