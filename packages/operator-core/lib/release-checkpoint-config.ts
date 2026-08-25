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

/**
 * EI-21363817573800034 — the QUALIFICATION HOLD (the scheduled gate's admission token).
 *
 * A coordination decision can forbid any candidate from qualifying (owner-directed
 * serializer holds: see `stable-candidate-related-gate-2026-08-23` D-028/D-029). Before this
 * existed, that prohibition was fail-closed for HUMANS AND AGENTS ONLY — the hourly scheduled
 * wrapper knew nothing about it, took the run-lock anyway, and a supervisor had to hand-stop the
 * systemd scope after the fact (D-025 at 18:16Z, D-031 at 19:20Z on 2026-08-24; both runs then
 * had to be marked permanently non-qualifying). This makes the hold machine-readable so the
 * scheduler declines on its own.
 *
 * Rides the SAME jsonb row as the thresholds above — the module header's stated extension path
 * ("addable to this same JSONB row incrementally (no further migration)").
 */
export interface QualificationHold {
  /** REQUIRED governing ref, e.g. 'stable-candidate-related-gate-2026-08-23#D-028'. A hold with
   *  no attributable authority is not a hold — it reads as malformed, which is fail-closed. */
  governingRef: string;
  /** Evidence only (what the hold is waiting on); the ACTIVE/CLEAR decision is the hold's
   *  presence, so a stale work-item read can never fail this open. */
  blockingItems?: string[];
  reason?: string;
  placedBy?: string;
  placedAtMs?: number;
}

/** The stored row: thresholds + the optional hold, sharing one jsonb payload. */
type CheckpointConfigRow = Partial<ReleaseCheckpointConfig> & {
  qualificationHold?: QualificationHold | null;
};

/**
 * Three-state ON PURPOSE. `unknown` is in-band and is NOT `clear`:
 *  - fail OPEN on a read error would defeat the whole guard (the unauthorized run launches);
 *  - fail CLOSED permanently would let one transient DB blip freeze `main` indefinitely.
 * So `unknown` skips THIS tick only and self-heals on the next one (hourly).
 */
export type QualificationAdmission =
  | { status: 'clear' }
  | { status: 'held'; hold: QualificationHold }
  | { status: 'unknown'; reason: string };

/**
 * Read admission FRESH — never `releaseCheckpointConfig()`.
 *
 * That accessor is a sync cache refreshed on boot + on local write, so a hold placed in ANOTHER
 * process (the supervisor's) is invisible to it for the life of this process. A hold must be read
 * atomically at launch or it does not bind.
 */
export async function readQualificationAdmission(
  opts: { workspaceId?: string } = {},
): Promise<QualificationAdmission> {
  let row: CheckpointConfigRow | null;
  try {
    row = await readOperatorState<CheckpointConfigRow>(
      'operator_release_checkpoint_config',
      opts.workspaceId,
    );
  } catch (e) {
    return { status: 'unknown', reason: e instanceof Error ? e.message : String(e) };
  }
  const hold = row?.qualificationHold;
  if (hold === undefined || hold === null) return { status: 'clear' };
  if (typeof hold !== 'object' || typeof hold.governingRef !== 'string' || hold.governingRef.trim() === '') {
    // Malformed ⇒ unknown, never clear: a corrupted token must not read as permission.
    return { status: 'unknown', reason: 'qualificationHold present but has no governingRef' };
  }
  return { status: 'held', hold };
}

/** Place (or, with `null`, lift) the hold, preserving the threshold fields in the same row. */
export async function setQualificationHold(hold: QualificationHold | null): Promise<void> {
  const row = (await readOperatorState<CheckpointConfigRow>('operator_release_checkpoint_config')) ?? {};
  const next: CheckpointConfigRow = { ...row };
  if (hold) next.qualificationHold = hold;
  else delete next.qualificationHold;
  await writeOperatorState<CheckpointConfigRow>('operator_release_checkpoint_config', next);
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
