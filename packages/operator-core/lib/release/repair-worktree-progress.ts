/**
 * Repair-worktree progress auto-commit (P-006, plan
 * gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * WHY THIS EXISTS (measured): a killed release-fixer leaves its edits UNCOMMITTED in the
 * frozen-repair worktree. Every deletion path (`cleanupFrozenRepairWorktree`'s
 * `worktree remove --force` behind fossil/dispatch-infeasible/outcome-reconciled/promoted/
 * verification-only, plus the abandoned-tree reaper) then destroys that work outright —
 * 23 uncommitted files stranded in green-candidate-papercusp-5738f8817eb6; a 45-min
 * fixer's 21 changes lost 2026-08-30. And even when nothing deletes the tree, dirty state
 * is POISONOUS: `shouldResyncRepairWorktree` skips a dirty tree, so after a repairHead
 * converge the next fixer works from a stale head and finalize burns an attempt on an
 * unreachable state.
 *
 * THE MECHANISM: snapshot dirty state as a real commit on the worktree's (detached) HEAD,
 * then pin it under `refs/papercusp/repair-progress/<key>`. Custom refs written from a
 * linked worktree land in the COMMON git dir, so the pin — and the commit it protects —
 * survive `git worktree remove --force` and directory removal. A committed snapshot also
 * turns "dirty" into "ahead", which the existing resync/converge/finalize machinery
 * already handles correctly: converge holds repairHead when commits have diverged, resync
 * preserves a not-behind tree, and finalize can promote a descendant chain.
 *
 * FAIL-SOFT BY CONTRACT: this runs inside the release gate and its sweeps. It NEVER
 * throws; any git failure (index.lock held by a live fixer mid-`git add`, a torn tree)
 * returns `{ outcome: 'failed' }` and the caller retries on its next tick.
 *
 * KNOWN LIMIT (deliberate v1): superproject-only. Dirty content INSIDE a materialized
 * submodule worktree (e.g. a migration edit under libs/papercusp) is not captured — the
 * superproject commit records only gitlink movement. Tracked as residue on WI-1961438.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const REPAIR_PROGRESS_REF_PREFIX = 'refs/papercusp/repair-progress/';

/** Identity mirrors the gate's existing automated-commit identity (green-checkpoint.ts). */
export const REPAIR_PROGRESS_COMMIT_USER_NAME = 'Papercusp Green Checkpoint';
export const REPAIR_PROGRESS_COMMIT_USER_EMAIL = 'green-checkpoint@papercusp.local';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Build the pin ref for one repair lane. Sanitizes so a hostile/odd pipeline name cannot
 * escape the namespace or produce an invalid refname. */
export function repairProgressRefName(pipeline: string, candidate: string): string {
  const safePipeline = String(pipeline).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'pipeline';
  const safeCandidate = String(candidate).replace(/[^0-9a-fA-F]+/g, '').slice(0, 12) || 'unknown';
  return `${REPAIR_PROGRESS_REF_PREFIX}${safePipeline}-${safeCandidate}`;
}

export interface RepairProgressExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RepairWorktreeProgressDeps {
  /** Run git. MUST resolve (not throw) on non-zero exit, reporting `code`. A throwing
   * exec is tolerated (treated as `failed`), but resolving keeps diagnostics richer. */
  exec(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number },
  ): Promise<RepairProgressExecResult>;
  log(message: string): void;
  /** Defaults to a real `.git` presence check. */
  hasGitDir?(worktreePath: string): boolean;
}

export type RepairWorktreeProgressOutcome =
  | { outcome: 'no-worktree' }
  | { outcome: 'clean' }
  | {
      outcome: 'committed';
      sha: string;
      dirtyPaths: number;
      /** False when the commit landed but the survivor ref could not be written — the
       * commit is then only as durable as the worktree itself. */
      refPinned: boolean;
      detail?: string;
    }
  | { outcome: 'failed'; detail: string };

/**
 * Snapshot a repair worktree's dirty state as a WIP commit and pin it to a survivor ref.
 * Never throws. A clean tree and a missing tree are cheap no-ops, so callers may invoke
 * this unconditionally on a sweep cadence.
 */
export async function commitRepairWorktreeProgress(opts: {
  worktreePath: string;
  /** Full survivor refname, normally from `repairProgressRefName`. */
  refName: string;
  /** Short human label baked into the commit subject (queue key / trigger site). */
  label: string;
  deps: RepairWorktreeProgressDeps;
  timeoutMs?: number;
}): Promise<RepairWorktreeProgressOutcome> {
  const { worktreePath, refName, label, deps } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasGitDir =
    deps.hasGitDir ?? ((p: string) => existsSync(join(p, '.git')));
  const git = async (args: string[]): Promise<RepairProgressExecResult> =>
    deps.exec('git', ['-C', worktreePath, ...args], { timeoutMs });
  try {
    if (!hasGitDir(worktreePath)) return { outcome: 'no-worktree' };

    const status = await git(['status', '--porcelain=v1']);
    if (status.code !== 0) {
      return { outcome: 'failed', detail: `status failed (${status.code}): ${trim(status.stderr)}` };
    }
    const dirtyPaths = status.stdout.split('\n').filter((line) => line.trim().length > 0).length;
    if (dirtyPaths === 0) return { outcome: 'clean' };

    const add = await git(['add', '-A']);
    if (add.code !== 0) {
      return { outcome: 'failed', detail: `add failed (${add.code}): ${trim(add.stderr)}` };
    }

    const commit = await git([
      '-c',
      `user.name=${REPAIR_PROGRESS_COMMIT_USER_NAME}`,
      '-c',
      `user.email=${REPAIR_PROGRESS_COMMIT_USER_EMAIL}`,
      'commit',
      '--no-verify',
      '-m',
      `WIP repair-progress auto-commit (${label}): ${dirtyPaths} dirty path(s) preserved`,
    ]);
    if (commit.code !== 0) {
      // `add -A` of purely-ignored churn stages nothing; git then refuses the commit.
      // That is a CLEAN verdict, not a failure — there was no trackable progress to save.
      const text = `${commit.stdout}\n${commit.stderr}`;
      if (/nothing (?:added )?to commit|no changes added to commit|nothing to commit/i.test(text)) {
        return { outcome: 'clean' };
      }
      return { outcome: 'failed', detail: `commit failed (${commit.code}): ${trim(commit.stderr) || trim(commit.stdout)}` };
    }

    const head = await git(['rev-parse', 'HEAD']);
    if (head.code !== 0 || !head.stdout.trim()) {
      return { outcome: 'failed', detail: `rev-parse HEAD failed after commit (${head.code}): ${trim(head.stderr)}` };
    }
    const sha = head.stdout.trim();

    const pin = await git(['update-ref', refName, sha]);
    if (pin.code !== 0) {
      deps.log(
        `warn: repair-progress commit ${sha.slice(0, 12)} landed but survivor ref ${refName} was not written (${trim(pin.stderr)}) — the snapshot is only as durable as the worktree`,
      );
      return { outcome: 'committed', sha, dirtyPaths, refPinned: false, detail: trim(pin.stderr) };
    }

    deps.log(
      `repair-progress auto-commit: preserved ${dirtyPaths} dirty path(s) in ${worktreePath} as ${sha.slice(0, 12)} (pinned ${refName}; ${label})`,
    );
    return { outcome: 'committed', sha, dirtyPaths, refPinned: true };
  } catch (error) {
    return {
      outcome: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function trim(text: string): string {
  return String(text ?? '').trim().slice(0, 400);
}
