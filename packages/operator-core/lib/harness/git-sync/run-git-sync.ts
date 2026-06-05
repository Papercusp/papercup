/**
 * The git-sync pipeline — git-sync-auto-commit. The pure-ish unit (inject `runGit`
 * + `repoPath` to test); `git-sync-action.ts` wraps it with locks, conflict
 * escalation + resolver, and routine-metadata recording.
 *
 * Syncs the WHOLE repo to origin — dynamically + recursively, no hardcoded list:
 *   - `syncOneRepo` is the per-repo primitive: commit dirty (whole-tree `git add -A`)
 *     → fetch → merge (handles diverged / non-fast-forward) → push. On a merge
 *     conflict it aborts to a CLEAN tree and reports the conflict (agents must never
 *     see a half-merged tree).
 *   - Submodules are discovered at runtime via `git submodule status --recursive`
 *     (auto-adjusts to whatever submodules exist, to any nesting depth — add/remove
 *     one and it's picked up with no code change) and synced **deepest-first**, so a
 *     child's commit is on its origin before any parent's pointer to it is pushed →
 *     a fresh clone of pushed `main` always resolves the entire tree. Each level's
 *     pointer bump shows up as a dirty change when its parent is synced.
 *   - The superproject is synced last.
 *
 * git-sync DELIBERATELY `git add -A`s each repo (unlike the SCOPED git-export
 * committer in `git-committer.ts`) — owning the whole-tree commit is its entire
 * purpose (it's why agents stop committing).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { projectDirForSlug } from '../../operator-notes';

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Spawn `git <args>` in `cwd`, capturing exit code + output (never throws). */
const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

export interface GitSyncConfig {
  /** Push to origin after committing/merging (default true). */
  push?: boolean;
  /** Sync submodules too (default true). When true, ALL submodules are synced
   *  recursively — discovery is dynamic, never a fixed list. */
  pushSubmodules?: boolean;
  /** Branch to sync when a repo is on a branch / for the superproject (default 'main'). */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  /** Commit subject (a default is used otherwise). */
  message?: string;
}

/** One (sub)repo that hit a merge conflict during a pass. */
export interface RepoConflict {
  /** Which repo conflicted: 'superproject' or a submodule path (repo-relative). */
  scope: string;
  conflictedFiles: string[];
}
/** One (sub)repo that errored (e.g. a push that wasn't a recoverable non-ff). */
export interface RepoError {
  scope: string;
  message: string;
}

/**
 * The aggregate result of one whole-repo pass. `pushed`/`merged` name the scopes
 * ('superproject' or submodule paths) that were pushed to / merged from origin, so
 * a caller can report exactly what moved. A pass NO LONGER stops at the first
 * conflict: it reconciles every submodule it can, COLLECTS conflicts/errors, and
 * only defers the superproject (see runGitSync). `status` is the worst outcome:
 * any conflict → 'conflict', else any error → 'error', else 'synced'/'nothing'.
 */
export type GitSyncOutcome =
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: string[]; merged: string[] }
  | { status: 'conflict'; conflicts: RepoConflict[]; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'error'; errors: RepoError[]; pushed: string[]; merged: string[] };

export interface RunGitSyncOpts {
  /** Override the repo path (tests); else resolved via `projectDirForSlug(slug)`. */
  repoPath?: string;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Repo-relative paths. */
  submodulePaths?: string[];
  log?: (m: string) => void;
}

const isDirty = async (runGit: RunGit, repo: string): Promise<boolean> => {
  const r = await runGit(['status', '--porcelain'], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
};

/** Current branch name, or null when HEAD is detached. */
const currentBranch = async (runGit: RunGit, repo: string): Promise<string | null> => {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : null;
};

const headSha = async (runGit: RunGit, repo: string): Promise<string> => {
  const r = await runGit(['rev-parse', 'HEAD'], repo);
  return r.stdout.trim();
};

const conflictedFiles = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], repo);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * Recursively discover submodule paths (repo-relative), DEEPEST-FIRST. Dynamic —
 * reads the live submodule tree (`git submodule status --recursive`), never a
 * hardcoded list. Skips uninitialized submodules (leading '-'). Deepest-first so a
 * child lands on its origin before a parent's pointer to it is pushed.
 */
const discoverSubmodulesRecursive = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code !== 0) return [];
  const paths = r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((l) => l[0] !== '-') // skip uninitialized
    .map((l) => l.slice(1).trim().split(/\s+/)[1]) // "<flag><sha> <path> (<describe>)" → path
    .filter(Boolean);
  return paths.sort((a, b) => b.split('/').length - a.split('/').length);
};

type RepoSyncResult =
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string };

/**
 * Sync ONE repo (superproject or a single submodule) to origin: commit dirty →
 * fetch → merge (reconciling a diverged/behind remote) → push. Never throws.
 */
async function syncOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: { remote: string; defaultBranch: string; message: string; doPush: boolean },
): Promise<RepoSyncResult> {
  const { remote, message, doPush } = o;
  const branch = (await currentBranch(runGit, repoPath)) ?? o.defaultBranch;

  let committedLocal = false;
  if (await isDirty(runGit, repoPath)) {
    await runGit(['add', '-A'], repoPath);
    const c = await runGit(['commit', '--no-verify', '-m', message], repoPath);
    if (c.code === 0) committedLocal = true;
  }

  const fetch = await runGit(['fetch', remote, branch], repoPath);
  if (fetch.code !== 0) {
    // Fetch failed (offline / transient). GAP-4: when we're meant to push and HEAD has
    // commits not on the last-known origin tip, those commits are NOT on origin — return
    // 'error' so runGitSync DEFERS the superproject. Otherwise the superproject would
    // commit + push a gitlink pointing at an unpushed submodule commit, which a fresh
    // clone can't resolve (this actually corrupted origin once). With push disabled, a
    // local commit is the expected local-only result.
    if (doPush) {
      const rl = await runGit(['rev-list', '--count', `${remote}/${branch}..HEAD`], repoPath);
      const aheadCount = rl.code === 0 ? Number.parseInt(rl.stdout.trim(), 10) || 0 : 1; // ref missing → assume unpushed
      if (committedLocal || aheadCount > 0) {
        return { status: 'error', message: `fetch failed; HEAD has unpushed commits not on ${remote}/${branch} (cannot reconcile)` };
      }
      return { status: 'nothing' };
    }
    return committedLocal ? { status: 'synced', pushed: false, merged: false } : { status: 'nothing' };
  }

  const merge = await runGit(['merge', '--no-edit', `${remote}/${branch}`], repoPath);
  if (merge.code !== 0) {
    const conflicted = await conflictedFiles(runGit, repoPath);
    await runGit(['merge', '--abort'], repoPath); // clean tree
    return { status: 'conflict', conflictedFiles: conflicted };
  }
  let mergedNew = !/Already up to date/i.test(merge.stdout);

  let pushed = false;
  if (doPush) {
    let push = await runGit(['push', remote, `HEAD:${branch}`], repoPath);
    if (push.code !== 0 && rejectedNonFastForward(push)) {
      // A peer pushed between our fetch and push — re-fetch + re-merge once.
      await runGit(['fetch', remote, branch], repoPath);
      const m2 = await runGit(['merge', '--no-edit', `${remote}/${branch}`], repoPath);
      if (m2.code !== 0) {
        const conflicted = await conflictedFiles(runGit, repoPath);
        await runGit(['merge', '--abort'], repoPath);
        return { status: 'conflict', conflictedFiles: conflicted };
      }
      mergedNew = mergedNew || !/Already up to date/i.test(m2.stdout);
      push = await runGit(['push', remote, `HEAD:${branch}`], repoPath);
    }
    if (push.code !== 0) {
      return { status: 'error', message: `push failed: ${push.stderr.trim() || push.stdout.trim()}` };
    }
    pushed = !/Everything up-to-date/i.test(`${push.stdout}\n${push.stderr}`);
  }

  if (!committedLocal && !mergedNew && !pushed) return { status: 'nothing' };
  return { status: 'synced', pushed, merged: mergedNew };
}

/**
 * Run one git-sync pass for `slug`. Syncs all submodules (recursively, deepest-first)
 * then the superproject. Returns a structured outcome; never throws. The caller
 * (git-sync-action) handles `conflict` (escalation + resolver, scoped to each repo
 * that conflicted) and records metadata.
 *
 * A conflict in ONE submodule no longer aborts the whole pass: every other submodule
 * still gets reconciled + pushed (a wedged libs/X must not block libs/Y). Conflicts +
 * errors are COLLECTED. The superproject, however, is only synced when EVERY submodule
 * reconciled — pushing the superproject while a submodule's local commits aren't yet on
 * its origin would publish a gitlink a fresh clone can't resolve. So a single
 * unreconciled submodule defers the superproject push to a later (clean) tick.
 */
export async function runGitSync(slug: string, opts: RunGitSyncOpts = {}): Promise<GitSyncOutcome> {
  const runGit = opts.runGit ?? defaultRunGit;
  const cfg = opts.config ?? {};
  const remote = cfg.remote ?? 'origin';
  const branch = cfg.branch ?? 'main';
  const doPush = cfg.push !== false;
  const doSub = cfg.pushSubmodules !== false;
  const message = cfg.message ?? `chore(git-sync): auto-commit ${slug} [skip ci]`;
  const log = opts.log ?? (() => {});

  const repo = opts.repoPath ?? (await projectDirForSlug(slug));
  if (!repo) {
    return { status: 'error', errors: [{ scope: 'superproject', message: `no repo path registered for harness '${slug}'` }], pushed: [], merged: [] };
  }

  const conflicts: RepoConflict[] = [];
  const errors: RepoError[] = [];
  const pushed: string[] = [];
  const merged: string[] = [];
  let didSomething = false;

  const absorb = (scope: string, r: RepoSyncResult): void => {
    if (r.status === 'conflict') {
      conflicts.push({ scope, conflictedFiles: r.conflictedFiles });
      log(`[git-sync] ${scope}: merge conflict (${r.conflictedFiles.join(', ')}) — aborted clean, continuing (${slug})`);
    } else if (r.status === 'error') {
      errors.push({ scope, message: r.message });
      log(`[git-sync] ${scope}: ${r.message} — continuing (${slug})`);
    } else if (r.status === 'synced') {
      didSomething = true;
      if (r.pushed) pushed.push(scope);
      if (r.merged) merged.push(scope);
    }
  };

  // Submodules first, deepest-first (dynamic recursive discovery). Each is independent —
  // a conflict/error in one is collected; the rest still sync.
  let subPaths: string[] = [];
  if (doSub) {
    subPaths = opts.submodulePaths
      ? [...opts.submodulePaths].sort((a, b) => b.split('/').length - a.split('/').length)
      : await discoverSubmodulesRecursive(runGit, repo);
  }
  for (const sub of subPaths) {
    absorb(sub, await syncOneRepo(runGit, join(repo, sub), { remote, defaultBranch: branch, message, doPush }));
  }

  // Superproject last — ONLY when every submodule reconciled (else its bumped pointers
  // would reference unpushed submodule commits). One unreconciled submodule defers it.
  const blocked = conflicts.length > 0 || errors.length > 0;
  if (!blocked) {
    absorb('superproject', await syncOneRepo(runGit, repo, { remote, defaultBranch: branch, message, doPush }));
  } else {
    log(`[git-sync] ${conflicts.length} conflict(s) + ${errors.length} error(s) in submodules — deferring superproject push (${slug})`);
  }

  if (conflicts.length > 0) return { status: 'conflict', conflicts, errors, pushed, merged };
  if (errors.length > 0) return { status: 'error', errors, pushed, merged };
  if (!didSomething) return { status: 'nothing' };
  return { status: 'synced', headSha: await headSha(runGit, repo), pushed, merged };
}
