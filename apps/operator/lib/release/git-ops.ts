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
import { join } from 'node:path';

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

/** SQL migration files newly added/changed between commits (deploy-staged schema).
 *
 * EI-856: submodule-aware. `libs/papercusp` (which holds `libs/db/sql/`) is a
 * git SUBMODULE — a migration landing entirely inside it shows up in the
 * SUPERPROJECT's own `git diff` only as the gitlink pointer moving, never as
 * the actual `.sql` path, so the plain `changedFiles` filter above silently
 * reports `[]` for a real migration. Two consumers relied on this being
 * accurate and were both wrong for a submodule-only migration: the deploy
 * plan's displayed `migrationCount`, and deploy.ts's `plan.migrations.length
 * > 0` gate that decides whether `rollback-db` (restoreSnapshot) runs at all —
 * so a submodule migration both under-reported AND silently disabled the
 * DB-rollback safety net. Fixed by ALSO diffing the submodule's own commit
 * history between its two pinned shas (submodulePins) and folding in any
 * matched migration paths (fail-soft: a diff hiccup there degrades to the
 * superproject-only result, never throws — this is a gate INPUT, and a
 * probe fault must never block the deploy pipeline it feeds). */
export async function migrationsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  const files = await changedFiles(repo, from, to);
  const superprojectMigrations = files.filter((f) => /(^|\/)libs\/papercusp\/libs\/db\/sql\/\d[^/]*\.sql$/.test(f));
  if (!from) return superprojectMigrations;
  const submoduleMigrations = await migrationsBetweenInSubmodule(repo, from, to, 'libs/papercusp');
  return [...new Set([...superprojectMigrations, ...submoduleMigrations])];
}

/**
 * Diff a submodule's OWN history between its gitlink pin at `from` and its pin
 * at `to` (both commit-ish in the SUPERPROJECT `repo`), returning any matched
 * migration paths prefixed with `submodulePath` so they read consistently
 * with the superproject-relative paths the caller already collects. Fail-soft
 * end to end (a shallow clone missing the pin commit, a detached/uninitialized
 * submodule, a pin that didn't move) — returns `[]` rather than throwing,
 * since this only ENRICHES the superproject diff and must never block it.
 */
async function migrationsBetweenInSubmodule(
  repo: string,
  from: string,
  to: string,
  submodulePath: string,
): Promise<string[]> {
  try {
    const [pinsFrom, pinsTo] = await Promise.all([submodulePins(repo, from), submodulePins(repo, to)]);
    const fromPin = pinsFrom.get(submodulePath);
    const toPin = pinsTo.get(submodulePath);
    if (!fromPin || !toPin || fromPin === toPin) return [];
    const submoduleRepo = join(repo, submodulePath);
    const files = await changedFiles(submoduleRepo, fromPin, toPin);
    // Paths here are relative to the SUBMODULE root (which mounts at
    // `libs/papercusp/`), so the migration dir reads as `libs/db/sql/...`
    // from inside it — re-prefix with the mount path for a consistent,
    // superproject-relative result the caller can display/compare directly.
    return files
      .filter((f) => /(^|\/)libs\/db\/sql\/\d[^/]*\.sql$/.test(f))
      .map((f) => `${submodulePath}/${f}`);
  } catch {
    return [];
  }
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

/**
 * Full-length (40-char) SHA of EVERY commit in `from..to` (EI-14601). A batched
 * fast-forward deploy lands N commits at once, but the deploy-landed event only ever
 * carried `payload.sha = targetSha` (the tip) — an agent awaiting the exact sha of an
 * earlier commit in the same batch (via `deploy:await{sha}`'s per-sha key, or a raw
 * `events:await` payload_filter on `sha`) would silently time out even though its
 * commit DID ship, because the exact-match never fires for anything but the tip. This
 * gives the deploy emitter the full commit list so it can fire the per-sha key for
 * every commit actually included, not just the target. `from: null` (first deploy —
 * no meaningful range) or an empty range returns `[]`.
 */
export async function commitShasBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) return [];
  const out = await git(repo, ['rev-list', `${from}..${to}`]);
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
