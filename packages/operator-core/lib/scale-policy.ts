/**
 * Account scale-out trigger policy (live-configurability-audit-2026-06-20 P-006).
 *
 * `ScalePolicy` (windowMs / sustainedPenaltyThreshold) decides when an account is "sustainedly
 * limited" — the verdict that gates the PAID auto-scale-out. The pure core (account-pool.ts) already
 * accepts it as a `policy` param, but the host call sites always passed DEFAULT_SCALE_POLICY. This is
 * the store: the host (account-pool-store.ts) now reads `readScalePolicy()` at the trigger + decision
 * + read-model sites.
 *
 * Empty store ⇒ DEFAULT_SCALE_POLICY (15min / 3) ⇒ byte-identical behavior, so this is safe-by-default.
 * Spend note: this only tunes WHEN scale-out fires; the provisioning itself stays owner-gated
 * (accounts:scale_out). Registers as a runtime-config override concern.
 *
 * FOLLOW-UP: EXHAUSTED_UTIL (1.0) / DRAIN_FULL_UTIL (0.97) are separate structural drain consts with
 * wide call-site fan-out — not part of ScalePolicy; making them settable is a larger follow-up.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { DEFAULT_SCALE_POLICY, type ScalePolicy } from './deployment/account-pool';

/** Effective policy = stored override merged over the baked DEFAULT_SCALE_POLICY. */
export async function readScalePolicy(): Promise<ScalePolicy> {
  const stored = await readOperatorState<Partial<ScalePolicy>>('operator_scale_policy');
  return { ...DEFAULT_SCALE_POLICY, ...(stored ?? {}) };
}

/** Merge a patch over the current policy + persist; returns the new effective policy. */
export async function writeScalePolicy(patch: Partial<ScalePolicy>): Promise<ScalePolicy> {
  const next = { ...(await readScalePolicy()), ...patch };
  await writeOperatorState<ScalePolicy>('operator_scale_policy', next);
  return next;
}

/** Reset to baked defaults (clears the override). */
export async function resetScalePolicy(): Promise<ScalePolicy> {
  await writeOperatorState<ScalePolicy>('operator_scale_policy', DEFAULT_SCALE_POLICY);
  return DEFAULT_SCALE_POLICY;
}

registerOverrideConcern({
  name: 'scale-policy',
  description: 'account scale-out trigger policy (windowMs / sustainedPenaltyThreshold)',
  auditAction: 'accounts:scale_policy',
  diff: async () => {
    const pol = await readScalePolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(DEFAULT_SCALE_POLICY) as (keyof ScalePolicy)[]) {
      if (pol[k] !== DEFAULT_SCALE_POLICY[k]) {
        entries.push({ key: k, effective: pol[k], default: DEFAULT_SCALE_POLICY[k], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readScalePolicy(),
  reset: () => resetScalePolicy(),
  restore: (snap) => writeScalePolicy(snap as ScalePolicy).then(() => {}),
});
