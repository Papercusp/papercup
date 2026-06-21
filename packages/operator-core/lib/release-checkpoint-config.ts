/**
 * Release / green-checkpoint config (live-configurability-audit-2026-06-20 P-016).
 *
 * The green-checkpoint stall + chronic-flake + deploy-backoff thresholds were module consts in
 * release-actions.ts. This store holds the runtime OVERRIDE; releaseCheckpointConfig() overlays a
 * SYNC-cached read over the const defaults so the release routines (periodic, but read sync) + the
 * pure shouldBackOff caller pick it up. Empty store ⇒ const defaults ⇒ byte-identical.
 *
 * Cache refreshed on boot + on write (same-process immediate); cross-process boot-bounded — fine for
 * these operational deploy-pipeline thresholds. Registers a runtime-config override concern.
 *
 * NOTE: green-checkpoint.ts vitest forks / suite-timeout, health-probe.ts probe timing, and the
 * auto-serve deploy drain_sec are SEPARATE consumers — addable to this same JSONB row incrementally
 * (no further migration); not threaded here (this item targets the release-actions.ts threshold set).
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface ReleaseCheckpointConfig {
  stallReds: number;
  stallAgeMs: number;
  chronicFlakeCount: number;
  flakeNotifyCooldownMs: number;
  deployBackoffMs: number;
}

/** The release-actions.ts const defaults (the baked fallback + diff/display baseline). */
export const RELEASE_CHECKPOINT_DEFAULTS: ReleaseCheckpointConfig = {
  stallReds: 3,
  stallAgeMs: 6 * 60 * 60 * 1000,
  chronicFlakeCount: 3,
  flakeNotifyCooldownMs: 24 * 60 * 60 * 1000,
  deployBackoffMs: 60 * 60_000,
};

let cached: Partial<ReleaseCheckpointConfig> = {};

/** Effective config = sync-cached override merged over the const defaults. */
export function releaseCheckpointConfig(): ReleaseCheckpointConfig {
  return { ...RELEASE_CHECKPOINT_DEFAULTS, ...cached };
}

export async function refreshReleaseCheckpointConfig(): Promise<void> {
  try {
    cached = (await readOperatorState<Partial<ReleaseCheckpointConfig>>('operator_release_checkpoint_config')) ?? {};
  } catch {
    /* keep last/empty — const defaults apply; never throw on the config path */
  }
}
void refreshReleaseCheckpointConfig();

export async function readReleaseCheckpointOverride(): Promise<Partial<ReleaseCheckpointConfig>> {
  return (await readOperatorState<Partial<ReleaseCheckpointConfig>>('operator_release_checkpoint_config')) ?? {};
}

export async function writeReleaseCheckpointConfig(patch: Partial<ReleaseCheckpointConfig>): Promise<Partial<ReleaseCheckpointConfig>> {
  const next = { ...(await readReleaseCheckpointOverride()), ...patch };
  await writeOperatorState<Partial<ReleaseCheckpointConfig>>('operator_release_checkpoint_config', next);
  cached = next;
  return next;
}

export async function setReleaseCheckpointOverride(cfg: Partial<ReleaseCheckpointConfig>): Promise<void> {
  await writeOperatorState<Partial<ReleaseCheckpointConfig>>('operator_release_checkpoint_config', cfg);
  cached = cfg;
}

export async function resetReleaseCheckpointConfig(): Promise<void> {
  await setReleaseCheckpointOverride({});
}

registerOverrideConcern({
  name: 'release-checkpoint-config',
  description: 'green-checkpoint / release thresholds (stall reds/age, chronic-flake count/cooldown, deploy backoff)',
  auditAction: 'release:checkpoint-config',
  diff: async () => {
    const c = await readReleaseCheckpointOverride();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(RELEASE_CHECKPOINT_DEFAULTS) as (keyof ReleaseCheckpointConfig)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: RELEASE_CHECKPOINT_DEFAULTS[k], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readReleaseCheckpointOverride(),
  reset: () => resetReleaseCheckpointConfig(),
  restore: (snap) => setReleaseCheckpointOverride((snap as Partial<ReleaseCheckpointConfig>) ?? {}),
});
