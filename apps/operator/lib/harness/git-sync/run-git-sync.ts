/**
 * The git-sync pipeline — git-sync-auto-commit Phase 2 (P-005..P-008). The pure-ish
 * unit (inject `runGit` + `repoPath` to test); the registered `system:git-sync`
 * action handler in `git-sync-action.ts` wraps this with locks (P-009), conflict
 * escalation + resolver spawn (P-010/P-012), and routine-metadata recording.
 *
 * Per tick, for one harness repo:
 *   1. Commit each dirty submodule, then **push submodule branches to origin FIRST**
 *      and stage the bumped pointer in the superproject (D-003 — so a fresh clone of
 *      pushed `main` resolves its pins).
 *   2. Commit the superproject. NOTE: unlike the SCOPED git-export committer
 *      (`git-committer.ts`, only `.harness/state`), git-sync DELIBERATELY
 *      `git add -A`s the whole tree — owning the whole-tree commit is its entire
 *      purpose (it's why agents stop committing). This is the one place a broad add
 *      is correct, because the system, not a peer agent, is the committer.
 *   3. `fetch` + `merge --no-edit origin/main` (merge, not rebase — D-002). On
 *      conflict: capture conflicted files, `merge --abort` to leave a CLEAN tree
 *      (agents must never see a half-merged tree), and return `conflict`.
 *   4. `push origin HEAD:main`. On non-fast-forward (a peer pushed mid-tick),
 *      re-fetch + re-merge once, else treat as conflict.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { projectDirForSlug } from '@/lib/operator-notes';

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
  /** Commit + push submodule branches before bumping the superproject pointer (default true). */
  pushSubmodules?: boolean;
  /** Branch to sync (default 'main'). */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  /** Commit subject (a default is used otherwise). */
  message?: string;
}

export type GitSyncOutcome =
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string };

export interface RunGitSyncOpts {
  /** Override the repo path (tests); else resolved via `projectDirForSlug(slug)`. */
  repoPath?: string;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Relative paths from the repo root. */
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

/** Submodule paths from `.gitmodules` (relative to repo root). */
const discoverSubmodules = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['config', '--file', '.gitmodules', '--get-regexp', 'path'], repo);
  if (r.code !== 0) return []; // no .gitmodules
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/).slice(1).join(' ').trim())
    .filter(Boolean);
};

function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/**
 * Run one git-sync pass for `slug`. Returns a structured outcome; never throws on
 * git failure (every git call is checked). The caller (git-sync-action) handles the
 * `conflict` outcome (escalation + resolver) and records metadata.
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
  if (!repo) return { status: 'error', message: `no repo path registered for harness '${slug}'` };

  let committedLocal = false;

  // 1. Submodules first: commit dirty, push the branch, stage the bumped pointer.
  const subPaths = opts.submodulePaths ?? (doSub ? await discoverSubmodules(runGit, repo) : []);
  for (const sub of subPaths) {
    const subAbs = join(repo, sub);
    if (await isDirty(runGit, subAbs)) {
      await runGit(['add', '-A'], subAbs);
      const c = await runGit(['commit', '--no-verify', '-m', message], subAbs);
      if (c.code === 0) committedLocal = true;
    }
    if (doPush) {
      const subBranch = (await currentBranch(runGit, subAbs)) ?? branch;
      const push = await runGit(['push', remote, `HEAD:${subBranch}`], subAbs);
      if (push.code !== 0) {
        // Don't bump a superproject pointer to a commit we couldn't publish — a fresh
        // clone would then fail to resolve the pin. Surface as error for this tick.
        return { status: 'error', message: `submodule '${sub}' push failed: ${push.stderr.trim() || push.stdout.trim()}` };
      }
    }
    // Stage the (possibly advanced) submodule pointer into the superproject index.
    await runGit(['add', '--', sub], repo);
  }

  // 2. Superproject: deliberate whole-tree commit (git-sync owns it; see header).
  if (await isDirty(runGit, repo)) {
    await runGit(['add', '-A'], repo);
    const c = await runGit(['commit', '--no-verify', '-m', message], repo);
    if (c.code === 0) committedLocal = true;
  }

  // 3. Fetch + merge origin/branch.
  const fetch = await runGit(['fetch', remote, branch], repo);
  if (fetch.code !== 0) {
    // Offline / no remote: a local commit still happened (or nothing did).
    log(`[git-sync] fetch failed (${slug}): ${fetch.stderr.trim()}`);
    return committedLocal
      ? { status: 'synced', headSha: await headSha(runGit, repo), pushed: false }
      : { status: 'nothing' };
  }
  const merge = await runGit(['merge', '--no-edit', `${remote}/${branch}`], repo);
  if (merge.code !== 0) {
    const conflicted = await conflictedFiles(runGit, repo);
    await runGit(['merge', '--abort'], repo); // restore a clean tree (P-010)
    return { status: 'conflict', conflictedFiles: conflicted };
  }
  const mergedNew = !/Already up to date/i.test(merge.stdout);

  // 4. Push.
  let pushed = false;
  if (doPush) {
    let push = await runGit(['push', remote, `HEAD:${branch}`], repo);
    if (push.code !== 0 && rejectedNonFastForward(push)) {
      // A peer pushed between our fetch and push — re-fetch + re-merge once.
      await runGit(['fetch', remote, branch], repo);
      const m2 = await runGit(['merge', '--no-edit', `${remote}/${branch}`], repo);
      if (m2.code !== 0) {
        const conflicted = await conflictedFiles(runGit, repo);
        await runGit(['merge', '--abort'], repo);
        return { status: 'conflict', conflictedFiles: conflicted };
      }
      push = await runGit(['push', remote, `HEAD:${branch}`], repo);
    }
    if (push.code !== 0) {
      return { status: 'error', message: `push failed: ${push.stderr.trim() || push.stdout.trim()}` };
    }
    // "Everything up-to-date" means the push moved nothing — don't count it as a sync.
    pushed = !/Everything up-to-date/i.test(`${push.stdout}\n${push.stderr}`);
  }

  if (!committedLocal && !mergedNew && !pushed) return { status: 'nothing' };
  return { status: 'synced', headSha: await headSha(runGit, repo), pushed };
}
