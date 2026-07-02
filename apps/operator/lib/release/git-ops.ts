/**
 * Git primitives for the release-gating system — plan
 * release-gate-ready-branch-2026-06-04.
 *
 * Pure git wrappers (no operator/DB deps) so the green-checkpoint + deploy +
 * rollback scripts share one tested implementation, and so they run standalone
 * even when the operator is down.
 *
 * Invariant: the green pin (`releaseRef` — the **`main` branch** since the
 * staging→main cutover, `staging-branch-pipeline-2026-06-06`) only ever
 * FAST-FORWARDS along the integration branch (`staging`) — never a merge,
 * never backward. The release worktree is DETACHED and the integration tree
 * lives on `staging`, so `git branch -f main` is always free to move.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', ['-C', repo, ...args], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function currentSha(repo: string): Promise<string> {
  return revParse(repo, 'HEAD');
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await revParse(repo, ref);
    return true;
  } catch {
    return false;
  }
}

/** Newest commit on `ref` whose commit time is ≤ `beforeUnixSec` (first-parent walk),
 *  or null when none qualifies. The quiet-cut primitive: "the tip as of T". */
export async function revListBefore(repo: string, ref: string, beforeUnixSec: number): Promise<string | null> {
  const out = await git(repo, ['rev-list', '-1', '--first-parent', `--before=${beforeUnixSec}`, ref]);
  return out || null;
}

/** Unix commit time (seconds) of `ref`. */
export async function commitUnixTime(repo: string, ref: string): Promise<number> {
  return Number(await git(repo, ['show', '-s', '--format=%ct', ref]));
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false; // non-zero exit = not an ancestor
  }
}

export interface AdvanceResult {
  advanced: boolean;
  from: string | null;
  to: string;
  /** created | fast-forwarded | already-at-candidate | not-fast-forward */
  reason: 'created' | 'fast-forwarded' | 'already-at-candidate' | 'not-fast-forward';
}

/**
 * Move `ready` to `candidate` — ONLY as a fast-forward (candidate must be a
 * descendant of current ready). Creates `ready` if it doesn't exist. Never
 * merges, never rewinds. This is the green-checkpoint's only write.
 */
export async function advanceReady(
  repo: string,
  candidate: string,
  readyRef = 'ready',
): Promise<AdvanceResult> {
  const to = await revParse(repo, candidate);
  if (!(await refExists(repo, readyRef))) {
    await git(repo, ['branch', readyRef, to]);
    return { advanced: true, from: null, to, reason: 'created' };
  }
  const from = await revParse(repo, readyRef);
  if (from === to) return { advanced: false, from, to, reason: 'already-at-candidate' };
  if (!(await isAncestor(repo, from, to))) {
    return { advanced: false, from, to, reason: 'not-fast-forward' };
  }
  await git(repo, ['branch', '-f', readyRef, to]);
  return { advanced: true, from, to, reason: 'fast-forwarded' };
}

/** Files changed between two commits (name-only). `from` null → empty. */
export async function changedFiles(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) return [];
  const out = await git(repo, ['diff', '--name-only', `${from}..${to}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** SQL migration files newly added/changed between commits (deploy-staged schema). */
export async function migrationsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  const files = await changedFiles(repo, from, to);
  return files.filter((f) => /(^|\/)libs\/papercusp\/libs\/db\/sql\/\d[^/]*\.sql$/.test(f));
}

/** One line per commit between two shas (oldest-last), for the release review. */
export async function commitsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) return [];
  const out = await git(repo, ['log', '--oneline', '--no-decorate', `${from}..${to}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Push a local ref to a remote (green-checkpoint publishes `ready`). */
export async function pushRef(repo: string, ref: string, remote = 'origin'): Promise<void> {
  await git(repo, ['push', remote, `${ref}:${ref}`]);
}

/** The gitlink sha each top-level submodule is pinned to at a given commit-ish. */
export async function submodulePins(
  repo: string,
  ref = 'HEAD',
): Promise<Map<string, string>> {
  const out = await git(repo, ['ls-tree', '-r', ref]);
  const pins = new Map<string, string>();
  for (const line of out.split('\n')) {
    // mode type sha\tpath  — gitlinks have type 'commit'
    const m = line.match(/^\d+ commit ([0-9a-f]{40})\t(.+)$/);
    if (m) pins.set(m[2], m[1]);
  }
  return pins;
}
