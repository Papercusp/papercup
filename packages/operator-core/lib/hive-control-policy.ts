/**
 * Hive control policy (live-configurability-audit-2026-06-20 P-015).
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
 * NOTE (D-005): placement AFFINITY weights are homed in hive:set-steering, NOT here — this carries only
 * the watchdog/liveness/health thresholds. (Work-distribution + system-health alarm thresholds can be
 * added to this same row incrementally — JSONB, no further migration.)
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface HiveControlPolicy {
  breakerThreshold?: number;
  recoveryDebounceMs?: number;
  dormancyGraceMs?: number;
  infraBreakerThreshold?: number;
}

/** The consumers' baked defaults — for diff/display + the tool's "default" reporting. */
export const HIVE_CONTROL_DEFAULTS = {
  breakerThreshold: 3,
  recoveryDebounceMs: 5 * 60_000,
  dormancyGraceMs: 10 * 60_000,
  infraBreakerThreshold: 12,
} as const;

// Sync cache so placementConfig() (sync, hot-ish per-sweep) can overlay the override without awaiting.
let cached: HiveControlPolicy = {};

/** The current override (sync) — overlaid by placementConfig() over its env defaults. */
export function placementOverride(): HiveControlPolicy {
  return cached;
}

export async function refreshHiveControlPolicy(): Promise<void> {
  try {
    cached = (await readOperatorState<HiveControlPolicy>('operator_hive_control_policy')) ?? {};
  } catch {
    /* keep the last value (empty at boot ⇒ env defaults) — never throw on the config path */
  }
}
void refreshHiveControlPolicy();

export async function readHiveControlPolicy(): Promise<HiveControlPolicy> {
  return (await readOperatorState<HiveControlPolicy>('operator_hive_control_policy')) ?? {};
}

export async function writeHiveControlPolicy(patch: HiveControlPolicy): Promise<HiveControlPolicy> {
  const next = { ...(await readHiveControlPolicy()), ...patch };
  await writeOperatorState<HiveControlPolicy>('operator_hive_control_policy', next);
  cached = next; // same-process immediate effect
  return next;
}

export async function setHiveControlPolicy(cfg: HiveControlPolicy): Promise<void> {
  await writeOperatorState<HiveControlPolicy>('operator_hive_control_policy', cfg);
  cached = cfg;
}

export async function resetHiveControlPolicy(): Promise<void> {
  await setHiveControlPolicy({});
}

registerOverrideConcern({
  name: 'hive-control-policy',
  description: 'hive placement-watchdog thresholds (breaker / recovery-debounce / dormancy-grace / infra-breaker)',
  auditAction: 'hive:control_policy',
  diff: async () => {
    const c = await readHiveControlPolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(HIVE_CONTROL_DEFAULTS) as (keyof HiveControlPolicy)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: HIVE_CONTROL_DEFAULTS[k], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readHiveControlPolicy(),
  reset: () => resetHiveControlPolicy(),
  restore: (snap) => setHiveControlPolicy((snap as HiveControlPolicy) ?? {}),
});
