/**
 * dev-deploy-state — the read-only release-gate snapshot behind the dev admin
 * rail's Deploy panel (plan dev-admin-sidebar-2026-06-05, P-006 / D-004).
 *
 * The #10 "my edit reverted" antidote: surfaces that the live operator's green
 * `:3070` runs from a SEPARATE release checkout (`papercup-release`) pinned to a
 * green ref, N commits / X hours behind `main`. A missing edit then reads as
 * *not-yet-deployed*, not *reverted*.
 *
 * Self-contained on purpose: it replicates the small slice of the release lib's
 * config + git primitives it needs (paths/refs + `git` shell-outs) rather than
 * importing `apps/operator/lib/release/*`. operator-core must not depend back on
 * apps/operator (wrong dependency direction), and the release lib also carries a
 * deploy/rollback surface this read panel must never reach. The refs/paths mirror
 * `release-config.ts` exactly (same env seams) so the two never drift.
 *
 * READ-ONLY (D-004): this computes + returns state. It never advances `ready`,
 * never deploys, never restarts — the deploy chokepoint stays the release-gate
 * agent's job.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const pexec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', ['-C', repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/** A commit identity: sha + commit epoch-ms + subject line. */
export interface CommitRef {
  sha: string;
  shortSha: string;
  committedAtMs: number;
  subject: string;
}

export interface DevDeployState {
  /** The churning integration tree git-sync commits to (resolves `main`/`ready`). */
  integrationRoot: string;
  /** The separate checkout the live `:3070` operator actually runs from. */
  releaseRoot: string;
  /** The green pin ref name (`ready`). */
  releaseRef: string;
  /** The integration branch name (`main`). */
  integrationBranch: string;

  /** Integration-branch HEAD (`main`). */
  mainHead: CommitRef | null;
  /** The green pin (`ready`) — what a deploy WOULD ship. null if unset. */
  ready: CommitRef | null;
  /** What the release checkout (the live `:3070`) is ACTUALLY running. */
  deployed: CommitRef | null;
  /** Best-effort wall-clock of the last deploy (release worktree HEAD mtime). */
  deployedAtMs: number | null;

  /** Commits `main` has that the DEPLOYED ref doesn't (how stale the live host is). */
  deployedBehindMain: number | null;
  /** Commits `main` has that `ready` doesn't (the staging buffer — main tip not yet green-checkpointed). */
  readyBehindMain: number | null;
  /** Commits `ready` has that the deployed ref doesn't (green & deployable but not yet deployed). */
  deployedBehindReady: number | null;
  /** True iff `ready` is exactly at `main` HEAD (main tip is green, fully caught up). */
  readyAtMainHead: boolean | null;

  /** Non-fatal problems gathering the snapshot (a ref didn't resolve, etc.). */
  errors: string[];
}

/** Resolve the release paths/refs the same way release-config.ts does (env seams). */
function resolveConfig(): Pick<
  DevDeployState,
  'integrationRoot' | 'releaseRoot' | 'releaseRef' | 'integrationBranch'
> {
  // PAPERCUSP_INTEGRATION_ROOT is exported into the :3070 operator's unit env
  // (the release-gate cutover). Off that env, derive from cwd's git toplevel.
  let integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
  if (!integrationRoot) {
    try {
      integrationRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      integrationRoot = process.cwd();
    }
  }
  const parent = path.dirname(integrationRoot);
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  return {
    integrationRoot,
    releaseRoot,
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'ready',
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'main',
  };
}

/** sha + commit date + subject for a ref in `repo`, or null on any failure. */
async function commitRef(repo: string, ref: string): Promise<CommitRef | null> {
  try {
    const sha = await git(repo, ['rev-parse', '--verify', ref + '^{commit}']);
    // Two separate reads instead of a delimited format — %ct (committer date,
    // epoch seconds) and %s (subject) come back clean with no field parsing.
    const ct = await git(repo, ['show', '-s', '--format=%ct', sha]);
    const subject = await git(repo, ['show', '-s', '--format=%s', sha]);
    return {
      sha,
      shortSha: sha.slice(0, 8),
      committedAtMs: Number(ct) * 1000,
      subject,
    };
  } catch {
    return null;
  }
}

/** Count of commits in `from..to` within `repo`, or null on failure. */
async function aheadCount(repo: string, from: string, to: string): Promise<number | null> {
  try {
    const out = await git(repo, ['rev-list', '--count', from + '..' + to]);
    return Number(out);
  } catch {
    return null;
  }
}

/** Best-effort last-deploy wall-clock: mtime of the release worktree's HEAD file. */
function lastDeployMtime(releaseRoot: string): number | null {
  // A linked worktree's HEAD lives under <gitdir>/worktrees/<name>/HEAD; the
  // .git entry at the worktree root is a `gitdir: …` pointer file rewritten on
  // checkout. Stat whichever resolves — both are touched on a deploy swap.
  const candidates = [path.join(releaseRoot, '.git', 'HEAD'), path.join(releaseRoot, '.git')];
  for (const c of candidates) {
    try {
      return Math.round(fs.statSync(c).mtimeMs);
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Compute the current release-gate snapshot. Pure read — shells `git` against the
 * integration + release checkouts; mutates nothing. Resolves a partial snapshot
 * with `errors[]` populated rather than throwing, so the panel always renders.
 */
export async function devDeployState(): Promise<DevDeployState> {
  const cfg = resolveConfig();
  const errors: string[] = [];

  const [mainHead, ready, deployed] = await Promise.all([
    commitRef(cfg.integrationRoot, cfg.integrationBranch),
    commitRef(cfg.integrationRoot, cfg.releaseRef),
    commitRef(cfg.releaseRoot, 'HEAD'),
  ]);

  if (!mainHead) errors.push('could not resolve ' + cfg.integrationBranch + ' in ' + cfg.integrationRoot);
  if (!ready) errors.push('ref ' + cfg.releaseRef + ' not found in ' + cfg.integrationRoot);
  if (!deployed) errors.push('could not resolve HEAD of release checkout ' + cfg.releaseRoot);

  // All counts are measured in the integration tree (it has every object — the
  // release worktree shares its object store). deployed must be reachable there.
  const [deployedBehindMain, readyBehindMain, deployedBehindReady] = await Promise.all([
    deployed && mainHead ? aheadCount(cfg.integrationRoot, deployed.sha, mainHead.sha) : Promise.resolve(null),
    ready && mainHead ? aheadCount(cfg.integrationRoot, ready.sha, mainHead.sha) : Promise.resolve(null),
    deployed && ready ? aheadCount(cfg.integrationRoot, deployed.sha, ready.sha) : Promise.resolve(null),
  ]);

  return {
    ...cfg,
    mainHead,
    ready,
    deployed,
    deployedAtMs: lastDeployMtime(cfg.releaseRoot),
    deployedBehindMain,
    readyBehindMain,
    deployedBehindReady,
    readyAtMainHead: readyBehindMain == null ? null : readyBehindMain === 0,
    errors,
  };
}
