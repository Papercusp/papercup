/**
 * Pot control policy (live-configurability-audit-2026-06-20 P-015).
 *
 * The placement-watchdog thresholds (breakerThreshold / recoveryDebounceMs / dormancyGraceMs /
 * infraBreakerThreshold) were PAPERCUSP_HIVE_PLACEMENT_* env gates read synchronously by
 * placementConfig() (consumed by the watchdog sweep, the sync-resolver UI read, and supervision
 * metrics — not all async). This store holds the runtime OVERRIDE; placementConfig() overlays a
 * SYNC-cached read of it over the env defaults, so every consumer sees the override without each
 * becoming async. Empty store ⇒ env/baked defaults ⇒ byte-identical.
 *
 * The cache is refreshed on boot + on every write (same-process immediate). Cross-process freshness is
 * boot-bounded — fine for these operational thresholds. Registers a runtime-config override concern.
 *
 * NOTE (D-005): placement AFFINITY weights are homed in pot:set-steering, NOT here — this carries only
 * the watchdog/liveness/health thresholds. (Work-distribution + system-health alarm thresholds can be
 * added to this same row incrementally — JSONB, no further migration.)
 *
 * NOTE (cup-lexicon-full-rename-2026-07-09 E6): only the TS-level identifiers below were renamed
 * Hive→Pot; the backing DB table/state-key (`operator_hive_control_policy`, migration
 * 350-operator-hive-control-policy.sql) is real schema and stays as-is — that rename is P-009
 * (DB rename), scoped separately and intentionally LAST in this plan.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface PotControlPolicy {
  breakerThreshold?: number;
  recoveryDebounceMs?: number;
  dormancyGraceMs?: number;
  infraBreakerThreshold?: number;
}

/** The consumers' baked defaults — for diff/display + the tool's "default" reporting. */
export const POT_CONTROL_DEFAULTS = {
  breakerThreshold: 3,
  recoveryDebounceMs: 5 * 60_000,
  dormancyGraceMs: 10 * 60_000,
  infraBreakerThreshold: 12,
} as const;

// Sync cache so placementConfig() (sync, hot-ish per-sweep) can overlay the override without awaiting.
let cached: PotControlPolicy = {};

/** The current override (sync) — overlaid by placementConfig() over its env defaults. */
export function placementOverride(): PotControlPolicy {
  return cached;
}

export async function refreshPotControlPolicy(): Promise<void> {
  try {
    cached = (await readOperatorState<PotControlPolicy>('operator_hive_control_policy')) ?? {};
  } catch {
    /* keep the last value (empty at boot ⇒ env defaults) — never throw on the config path */
  }
}
void refreshPotControlPolicy();

export async function readPotControlPolicy(): Promise<PotControlPolicy> {
  return (await readOperatorState<PotControlPolicy>('operator_hive_control_policy')) ?? {};
}

export async function writePotControlPolicy(patch: PotControlPolicy): Promise<PotControlPolicy> {
  const next = { ...(await readPotControlPolicy()), ...patch };
  await writeOperatorState<PotControlPolicy>('operator_hive_control_policy', next);
  cached = next; // same-process immediate effect
  return next;
}

export async function setPotControlPolicy(cfg: PotControlPolicy): Promise<void> {
  await writeOperatorState<PotControlPolicy>('operator_hive_control_policy', cfg);
  cached = cfg;
}

export async function resetPotControlPolicy(): Promise<void> {
  await setPotControlPolicy({});
}

registerOverrideConcern({
  name: 'pot-control-policy',
  description: 'pot placement-watchdog thresholds (breaker / recovery-debounce / dormancy-grace / infra-breaker)',
  auditAction: 'pot:control_policy',
  diff: async () => {
    const c = await readPotControlPolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(POT_CONTROL_DEFAULTS) as (keyof PotControlPolicy)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: POT_CONTROL_DEFAULTS[k], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readPotControlPolicy(),
  reset: () => resetPotControlPolicy(),
  restore: (snap) => setPotControlPolicy((snap as PotControlPolicy) ?? {}),
});
