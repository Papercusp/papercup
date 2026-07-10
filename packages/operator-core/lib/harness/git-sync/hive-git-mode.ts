/**
 * hive-git-mode — the per-hive GitHub-bridge mode seam
 * (github-bridge-hive-egress-2026-07-02 P-003 / S-5, decisions D-001/D-002).
 *
 * One hive-wide switch decides WHO pushes the GitHub remote:
 *
 *   - `legacy`   (DEFAULT, and the value for every hive with no setting):
 *     today's behavior byte-for-byte — each member's git-sync routine pushes
 *     origin per `decideGitSyncPush`'s existing five rules. Non-bridged hives
 *     never change behavior.
 *   - `bridged`  : the hive code plane is P2P (`lib/sync/hive-git/`) AND the
 *     GitHub bridge egresses canonical refs (plan P-001, S-2). Member git-sync
 *     goes COMMIT-ONLY — the bridge writer (the integrator lock-authority
 *     lease holder, D-002) is the SOLE origin pusher, so a member routine
 *     pushing origin alongside it would double-push / race the canonical refs.
 *   - `p2p-only` : the hive syncs exclusively on the P2P plane; no GitHub
 *     remote is pushed by anyone (no bridge either). Member git-sync is
 *     commit-only.
 *
 * The mode lives in the FEDERATED `hive_settings` store (key `hiveGit.mode`,
 * same idiom as `release.greenCmd`) so one owner-side flip reaches every
 * member machine's seed AND run paths — a member must never need a re-seed to
 * stop double-pushing (the run-time gate in git-sync-action re-consults this
 * every tick).
 *
 * Pure coercion + a thin read/write accessor pair over `hive-settings-store`;
 * junk-safe like `coerceHivePolicyInput` — an unknown/malformed value reads as
 * `legacy` (fail-open to today's behavior, never to a silent push-stop).
 *
 * ACCEPTED RISK (review 2026-07-02): fail-open means a PG blip on a BRIDGED
 * hive briefly re-enables member push → a possible double-push window against
 * the bridge writer. Safe by construction: both pushers are FF-only + CAS, so
 * one wins and the other rejects noisily — divergence surfaces, refs never
 * corrupt. Do not "fix" this by failing closed; a blip silencing a healthy
 * legacy hive's pushes is the worse failure.
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting, deleteHiveSetting } from '../../hive-settings-store';

/** Who pushes the GitHub remote for this hive (S-5 decision table input). */
export type PotGitMode = 'legacy' | 'bridged' | 'p2p-only';

/** The federated hive_settings key carrying the mode. */
export const POT_GIT_MODE_SETTING_KEY = 'hiveGit.mode';

export const POT_GIT_MODES: readonly PotGitMode[] = ['legacy', 'bridged', 'p2p-only'] as const;

/** Junk-safe coercion: anything that is not exactly a known mode is `legacy`. */
export function coercePotGitMode(v: unknown): PotGitMode {
  return v === 'bridged' || v === 'p2p-only' ? v : 'legacy';
}

/**
 * Read a hive's git mode from the federated settings store. Absent / unset /
 * malformed → `legacy`. NEVER throws: a settings-store failure also reads as
 * `legacy` (fail-open to today's behavior — a PG blip must not flip a healthy
 * legacy hive into silent commit-only mode).
 */
export async function getPotGitMode(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<PotGitMode> {
  try {
    const rec = await getHiveSetting(workspaceId, potHomeSlug, POT_GIT_MODE_SETTING_KEY, sql);
    return coercePotGitMode(rec?.value);
  } catch {
    return 'legacy';
  }
}

/**
 * Set (or clear, with `mode: null`) a hive's git mode. `legacy` is stored
 * explicitly when passed (an explicit choice is auditable); clearing removes
 * the row so the hive reads as default-legacy again. Validates the mode —
 * unlike the read path, a WRITE with a junk value must throw, not coerce.
 */
export async function setPotGitMode(
  workspaceId: string,
  potHomeSlug: string,
  mode: PotGitMode | null,
  sql?: Sql,
): Promise<void> {
  if (mode === null) {
    await deleteHiveSetting(workspaceId, potHomeSlug, POT_GIT_MODE_SETTING_KEY, sql);
    return;
  }
  if (!POT_GIT_MODES.includes(mode)) {
    throw new Error(`setPotGitMode: unknown mode '${String(mode)}' (expected ${POT_GIT_MODES.join(' | ')})`);
  }
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: POT_GIT_MODE_SETTING_KEY, value: mode }, sql);
}
