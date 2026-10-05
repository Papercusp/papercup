/**
 * pot-integration-mode — where a pot's combined agent work goes
 * (plan pot-review-integration-mode-2026-10-05, P-014 / P-015; decisions D-005, D-006, D-007).
 *
 * One per-pot switch, stored in the FEDERATED `hive_settings` store under
 * `hiveGit.integration` (beside `hiveGit.mode`, and deliberately orthogonal to
 * it — D-005: `hiveGit.mode` decides WHO pushes, this decides WHERE the pot's
 * work lands):
 *
 *   - `direct` (DEFAULT, and the value for every pot with no setting): today's
 *     behavior byte for byte — git-sync pushes the pot's repository as before.
 *   - `review` ("into a working copy", D-007): inside the pot nothing changes —
 *     agents share the tree and git-sync commits as today (D-006) — but git-sync
 *     pushes to the POT'S OWN FORK instead of the main repository. The main
 *     repository receives the pot's combined work only through PRs.
 *
 * FAIL DIRECTION (the inverse of `hive-git-mode`'s fail-open, on purpose).
 * `hiveGit.mode` fails OPEN to legacy because a blip silencing a healthy hive's
 * pushes was judged worse than a brief double-push. Here the asymmetry runs the
 * other way: a working-copy pot exists to keep unreviewed work OUT of the main
 * repository, so a store read that throws — or a value nobody can interpret —
 * must never resolve to "push the main repository". {@link resolveIntegrationPushRemote}
 * therefore turns `error` and `malformed` into COMMIT-ONLY (the work stays
 * committed locally and is pushed on the next healthy tick), and only a pot that
 * has NO setting at all (`absent`) or an explicit `direct` keeps today's push.
 * A review pot with no fork configured is commit-only too: it never falls back
 * to the main repository.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting, deleteHiveSetting } from '../../hive-settings-store';
import { parseGithubUrl } from '../clone-github';
import type { EnsureForkOpts, EnsureForkResult } from '../ensure-fork';
import { resolveForkPushTarget, setForkRemote, type SetForkRemoteResult } from './fork-remote';

let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/** Where this pot's combined work goes. */
export type PotIntegrationMode = 'direct' | 'review';

/** The federated hive_settings key carrying the mode (D-005). */
export const POT_INTEGRATION_SETTING_KEY = 'hiveGit.integration';

export const POT_INTEGRATION_MODES: readonly PotIntegrationMode[] = ['direct', 'review'] as const;

/** The git remote NAME git-sync uses for a working-copy pot's fork. */
export const POT_FORK_REMOTE_NAME = 'pot-fork';

/** Junk-safe coercion: exactly `review` is review; anything else reads as `direct`. */
export function coercePotIntegrationMode(v: unknown): PotIntegrationMode {
  return v === 'review' ? 'review' : 'direct';
}

/**
 * Why the pot read as the mode it did. Only `set` and `absent` are trustworthy;
 * `malformed` and `error` mean the mode could not be established, and the push
 * resolver refuses to push anywhere for them.
 */
export type PotIntegrationModeSource = 'set' | 'absent' | 'malformed' | 'error';

export interface PotIntegrationModeRead {
  /** Always a usable mode — `direct` whenever the source is not `set`. */
  mode: PotIntegrationMode;
  source: PotIntegrationModeSource;
}

/** Read the pot's integration mode and why it reads that way. Never throws. */
export async function readPotIntegrationMode(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<PotIntegrationModeRead> {
  let rec: Awaited<ReturnType<typeof getHiveSetting>>;
  try {
    rec = await getHiveSetting(workspaceId, potHomeSlug, POT_INTEGRATION_SETTING_KEY, sql);
  } catch {
    return { mode: 'direct', source: 'error' };
  }
  if (!rec || rec.value == null) return { mode: 'direct', source: 'absent' };
  if (rec.value === 'direct' || rec.value === 'review') return { mode: rec.value, source: 'set' };
  return { mode: 'direct', source: 'malformed' };
}

/** What git-sync should do with this tick's push, given the pot's integration mode. */
export type IntegrationPushDecision =
  /** `direct` mode: the existing push logic applies, unchanged. */
  | { kind: 'unchanged'; reason: string }
  /** `review` mode with a fork: push to the fork through the `pot-fork` remote. */
  | { kind: 'fork'; remoteName: typeof POT_FORK_REMOTE_NAME; url: string; reason: string }
  /** Commit locally, push nowhere. Never falls back to the main repository. */
  | {
      kind: 'commit-only';
      reason: 'working_copy_fork_missing' | 'integration_mode_unknown' | 'integration_mode_malformed';
      message: string;
    };

export interface ResolveIntegrationPushInput {
  read: PotIntegrationModeRead;
  /** The pot's fork remote URL (registry `fork_remote`), when configured. */
  forkRemote?: string;
}

/** PURE: decide this tick's push target from the mode read and the fork URL. */
export function resolveIntegrationPushRemote(input: ResolveIntegrationPushInput): IntegrationPushDecision {
  const { read } = input;
  if (read.source === 'error') {
    return {
      kind: 'commit-only',
      reason: 'integration_mode_unknown',
      message:
        'could not read hiveGit.integration (settings store error) — committing locally and pushing nowhere this ' +
        'tick, so a working-copy pot can never leak unreviewed work into the main repository on a read failure',
    };
  }
  if (read.source === 'malformed') {
    return {
      kind: 'commit-only',
      reason: 'integration_mode_malformed',
      message:
        'hiveGit.integration holds an unrecognized value — committing locally and pushing nowhere until it is set ' +
        "to 'direct' or 'review'",
    };
  }
  if (read.mode === 'direct') {
    return {
      kind: 'unchanged',
      reason: read.source === 'set' ? 'integration mode direct (explicit)' : 'integration mode direct (default — not configured)',
    };
  }
  // The fork URL comes through the shared fork-remote seam (P-014). No upstream is
  // passed, so the seam can only answer `fork` or `none`; it can never pick the
  // main repository for a working-copy pot.
  const target = resolveForkPushTarget({ forkRemote: input.forkRemote });
  if (target.target !== 'fork') {
    return {
      kind: 'commit-only',
      reason: 'working_copy_fork_missing',
      message:
        'pot is in working-copy (review) mode but has no fork configured — committing locally and pushing nowhere; ' +
        'the main repository only receives this pot’s work through a PR',
    };
  }
  return {
    kind: 'fork',
    remoteName: POT_FORK_REMOTE_NAME,
    url: target.remote,
    reason: 'working-copy mode — git-sync pushes the pot’s own fork, never the main repository (D-006)',
  };
}

export type RunGit = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const defaultRunGit: RunGit = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return { stdout };
};

/**
 * Make `<repoPath>`'s `pot-fork` git remote point at `url`: add it when missing,
 * re-point it when it drifted, leave it alone when it already matches.
 */
export async function ensurePotForkGitRemote(
  repoPath: string,
  url: string,
  runGit: RunGit = defaultRunGit,
): Promise<'added' | 'updated' | 'unchanged'> {
  let current: string | null = null;
  try {
    current = (await runGit(['remote', 'get-url', POT_FORK_REMOTE_NAME], repoPath)).stdout.trim();
  } catch {
    current = null;
  }
  if (current === null) {
    await runGit(['remote', 'add', POT_FORK_REMOTE_NAME, url], repoPath);
    return 'added';
  }
  if (current !== url) {
    await runGit(['remote', 'set-url', POT_FORK_REMOTE_NAME, url], repoPath);
    return 'updated';
  }
  return 'unchanged';
}

/** The push-target slice of the git-sync tick config that working-copy mode rewrites. */
export interface IntegrationPushConfig {
  push?: boolean;
  remote?: string;
  pushSubmoduleOrigins?: boolean;
}

/** Why a working-copy tick commits locally and pushes nowhere. */
export type IntegrationCommitOnlyReason =
  | Extract<IntegrationPushDecision, { kind: 'commit-only' }>['reason']
  | 'working_copy_no_repo_path'
  | 'working_copy_fork_remote_setup_failed';

/**
 * pot-review-integration-mode P-014: apply this tick's working-copy push target
 * to the git-sync config, in place.
 *
 * `fork` points the `pot-fork` remote at the fork and pushes there; submodule
 * origins are NOT pushed (they are the main repositories' submodules — pushing
 * them would leak unreviewed work past the PR). `commit-only`, or a fork remote
 * that cannot be set up, commits locally and pushes nowhere. Never falls back to
 * the main repository. Returns the commit-only reason, or null when it pushes.
 */
export async function applyIntegrationPushTarget(
  slug: string,
  cfg: IntegrationPushConfig,
  decision: IntegrationPushDecision | undefined,
  repoPath: string | null | undefined,
  ensureRemote: (repoPath: string, url: string) => Promise<unknown> = ensurePotForkGitRemote,
): Promise<IntegrationCommitOnlyReason | null> {
  if (!decision || decision.kind === 'unchanged') return null;
  const commitOnly = (reason: IntegrationCommitOnlyReason): IntegrationCommitOnlyReason => {
    cfg.push = false;
    cfg.pushSubmoduleOrigins = false;
    return reason;
  };
  if (decision.kind === 'commit-only') {
    console.log(`[git-sync] ${slug}: ${decision.message} (${decision.reason})`);
    return commitOnly(decision.reason);
  }
  if (!repoPath) {
    console.log(`[git-sync] ${slug}: working-copy mode but no checkout path — committing locally, pushing nowhere`);
    return commitOnly('working_copy_no_repo_path');
  }
  try {
    await ensureRemote(repoPath, decision.url);
  } catch (err) {
    console.log(
      `[git-sync] ${slug}: could not set up the ${POT_FORK_REMOTE_NAME} remote ` +
        `(${err instanceof Error ? err.message : String(err)}) — committing locally, pushing nowhere`,
    );
    return commitOnly('working_copy_fork_remote_setup_failed');
  }
  cfg.remote = decision.remoteName;
  cfg.pushSubmoduleOrigins = false;
  console.log(`[git-sync] ${slug}: ${decision.reason}`);
  return null;
}

export type SetPotIntegrationModeResult =
  | { ok: true; mode: PotIntegrationMode | null }
  | { ok: false; error: 'green_cmd_required' | 'fork_required'; message: string };

export interface SetPotIntegrationModeInput {
  workspaceId: string;
  potHomeSlug: string;
  /** `null` clears the setting (the pot reads as default `direct` again). */
  mode: PotIntegrationMode | null;
  /** The pot's resolved green-gate test command (release.greenCmd), if any. */
  greenCmd: string | null | undefined;
  /** The pot's fork remote URL, if one is configured. */
  forkRemote: string | null | undefined;
  sql?: Sql;
}

/**
 * Set the pot's integration mode. Choosing `review` (working copy) is refused
 * unless the pot has a configured green-gate test command (P-015 — "passed the
 * test suite" must never be vacuous) and a fork to push to (the guided switch
 * creates the fork first). An unknown mode throws: a WRITE never coerces.
 */
export async function setPotIntegrationMode(input: SetPotIntegrationModeInput): Promise<SetPotIntegrationModeResult> {
  const { workspaceId, potHomeSlug, mode, sql } = input;
  if (mode === null) {
    await deleteHiveSetting(workspaceId, potHomeSlug, POT_INTEGRATION_SETTING_KEY, sql);
    return { ok: true, mode: null };
  }
  if (!POT_INTEGRATION_MODES.includes(mode)) {
    throw new Error(
      `setPotIntegrationMode: unknown mode '${String(mode)}' (expected ${POT_INTEGRATION_MODES.join(' | ')})`,
    );
  }
  if (mode === 'review') {
    if (!input.greenCmd || !input.greenCmd.trim()) {
      return {
        ok: false,
        error: 'green_cmd_required',
        message:
          'working-copy mode needs a test suite: set the pot’s green-gate test command (release.greenCmd) first, ' +
          'so a PR built from the working copy has really passed tests',
      };
    }
    if (!input.forkRemote) {
      return {
        ok: false,
        error: 'fork_required',
        message: 'working-copy mode needs the pot’s own fork: create or configure the fork first',
      };
    }
  }
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: POT_INTEGRATION_SETTING_KEY, value: mode }, sql);
  return { ok: true, mode };
}

export type ChoosePotIntegrationModeResult =
  | { ok: true; mode: PotIntegrationMode | null; fork: { url: string; created: boolean } | null }
  | {
      ok: false;
      error:
        | 'green_cmd_required'
        | 'fork_required'
        | 'upstream_remote_required'
        | 'fork_is_main_repository'
        | 'fork_create_failed'
        | 'fork_record_failed';
      message: string;
    };

export interface ChoosePotIntegrationModeInput extends SetPotIntegrationModeInput {
  /** The pot's registry slug (where `fork_remote` is recorded). */
  harnessSlug: string;
  /** The main repository (registry `github_remote`) the fork is made from. */
  upstreamRemote: string | null | undefined;
}

export interface ChoosePotIntegrationModeDeps {
  ensureFork?: (opts: EnsureForkOpts) => Promise<EnsureForkResult>;
  setForkRemote?: (slug: string, forkUrl: string | null, workspaceId?: string) => Promise<SetForkRemoteResult>;
  setMode?: (input: SetPotIntegrationModeInput) => Promise<SetPotIntegrationModeResult>;
}

/**
 * P-014: choose the pot's integration mode. Choosing `review` (working copy)
 * CREATES the pot's fork of the main repository when none is recorded
 * (ensureFork) and records it as the registry `fork_remote` before the mode is
 * set, so git-sync's next tick pushes to the fork. The test-command check runs
 * first, so a refused switch never creates a fork. A fork that resolves to the
 * main repository itself (the signed-in account owns it) is refused: working-copy
 * mode must never push the main repository.
 */
export async function choosePotIntegrationMode(
  input: ChoosePotIntegrationModeInput,
  deps: ChoosePotIntegrationModeDeps = {},
): Promise<ChoosePotIntegrationModeResult> {
  const setMode = deps.setMode ?? setPotIntegrationMode;
  if (input.mode !== 'review' || input.forkRemote) {
    const r = await setMode(input);
    return r.ok ? { ok: true, mode: r.mode, fork: null } : r;
  }
  if (!input.greenCmd || !input.greenCmd.trim()) {
    return setMode(input) as Promise<ChoosePotIntegrationModeResult>;
  }
  const upstream = input.upstreamRemote ? parseGithubUrl(input.upstreamRemote) : null;
  if (!upstream) {
    return {
      ok: false,
      error: 'upstream_remote_required',
      message: 'working-copy mode needs the pot’s main repository on GitHub, to fork it',
    };
  }
  const ensure =
    deps.ensureFork ?? (async (o: EnsureForkOpts) => (await import('../ensure-fork')).ensureFork(o));
  let fork: EnsureForkResult;
  try {
    fork = await ensure({ upstreamOwner: upstream.owner, upstreamRepo: upstream.repo });
  } catch (err) {
    return {
      ok: false,
      error: 'fork_create_failed',
      message: `could not create the pot’s fork: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (fork.forkFullName.toLowerCase() === `${upstream.owner}/${upstream.repo}`.toLowerCase()) {
    return {
      ok: false,
      error: 'fork_is_main_repository',
      message:
        `the signed-in GitHub account owns ${upstream.owner}/${upstream.repo}, so it cannot fork it; ` +
        'configure a fork owned by another account or organization',
    };
  }
  const recorded = await (deps.setForkRemote ?? setForkRemote)(
    input.harnessSlug,
    `https://github.com/${fork.forkFullName}.git`,
    input.workspaceId,
  );
  if (!recorded.ok || !recorded.forkRemote) {
    return {
      ok: false,
      error: 'fork_record_failed',
      message: recorded.ok ? 'fork remote was not recorded' : recorded.message,
    };
  }
  const r = await setMode({ ...input, forkRemote: recorded.forkRemote });
  return r.ok ? { ok: true, mode: r.mode, fork: { url: recorded.forkRemote, created: fork.created } } : r;
}
