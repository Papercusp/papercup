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
 *
 * WI-1416: the pass is CHECKPOINTABLE — three phases (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) run under the injectable
 * `RunGitSyncOpts.step` seam so a durable caller records one DBOS
 * operation_output per phase, and every git subprocess is time-bounded (the hang
 * guard below). See GitSyncStepRunner for the replay-safety contract.
 */
import { spawn } from 'node:child_process';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDirForSlug } from '../../operator-notes';
import { isSidecarEnabledFromEnv } from '../../process-supervision/sidecar-spawn-shared';
import { detectContentOffenders, type ContentOffender } from './content-guard';
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from '../../content-lint/registry';
import {
  groupFilesForAttribution,
  attributionMapForRepo,
  type FileAttribution,
  type AttributionRosterEntry,
} from './git-sync-attribution';

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const envMs = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Subcommands that touch the network (a hung remote must fail fast, not stall the fire). */
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

/** The git SUBCOMMAND in an argv — skipping leading global flags AND the separate
 *  value a `-c`/`-C` option consumes (`['-c','x=y','fetch']` → 'fetch', not 'x=y'). */
const gitSubcommand = (args: string[]): string => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++; // the option's value rides in the NEXT token
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return '';
};

/**
 * WI-1416 hang guard: the ceiling for one git subprocess. A wedged git (typically a
 * network push/fetch against a stuck remote) used to hang the whole fire until the
 * executor reaper cancelled it — an opaque reap instead of a recorded error. Bounded,
 * the call fails FAST with a "timed out" stderr that flows into the outcome's
 * errors[] → routine metadata.last_error (git-sync-stall-watchdog-visible).
 * Env-tunable: PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS / PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS.
 */
export const gitTimeoutMsFor = (args: string[]): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? envMs('PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS', 4 * 60_000)
    : envMs('PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS', 6 * 60_000);

/** Spawn `git <args>` in `cwd`, capturing exit code + output, bounded by `timeoutMs`
 *  (never throws, never hangs). Exported so the hang guard is directly testable.
 *  WI-3793: now backed by the shared, defensively-guarded
 *  `isSidecarEnabledFromEnv` (same enable/mode-var pattern every node-child
 *  sidecar shares) instead of a hand-rolled inline check — behavior is
 *  unchanged (this was already the ONE call site with the `_MODE` guard). */
export function gitSyncSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSidecarEnabledFromEnv(
    {
      enableVar: 'PAPERCUSP_SPAWNER_SIDECAR',
      modeVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      explicitVar: 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR',
    },
    env,
  );
}

async function runGitViaSpawnerSidecar(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawnSpawnerSidecar } = await import('../../fleet/spawner-sidecar-spawn');
  const { getSpawnerIpcClient } = await import('../../fleet/spawner-ipc-client');
  await spawnSpawnerSidecar();
  const client = getSpawnerIpcClient();
  return client.call<{ code: number; stdout: string; stderr: string }>(
    'process:exec',
    {
      command: 'git',
      args,
      cwd,
      env,
      timeoutMs,
    },
    // The sidecar process owns the actual timeout. Keep the client timeout longer
    // so it does not race a legitimate timeout response.
    { timeoutMs: timeoutMs + 35_000 },
  );
}

const runGitLocalBounded = (
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
    // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
    // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
    // parsing is then reliable at the root, rather than depending on the operator's locale.
    //
    // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
    // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
    // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
    // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
    // this marker the hook would run the affected suite on the scheduled push and wedge
    // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
    // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', PAPERCUSP_GIT_SYNC_PUSH: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    // WI-1416 hang guard: SIGTERM first (git traps it and cleans its lock files),
    // SIGKILL after a grace, and a last-resort resolve in case 'close' never fires.
    // All timers unref'd so a pending guard never keeps the process alive.
    const term = setTimeout(() => {
      stderr += `${stderr ? '\n' : ''}git ${args.join(' ')} timed out after ${timeoutMs}ms — killed by the git-sync hang guard`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
      setTimeout(() => finish(-1), 20_000).unref?.();
    }, timeoutMs);
    term.unref?.();
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(term);
      stderr += String(e);
      finish(-1);
    });
    child.on('close', (code) => {
      clearTimeout(term);
      finish(code ?? -1);
    });
  });

export const runGitBounded = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
  // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
  // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
  // parsing is then reliable at the root, rather than depending on the operator's locale.
  //
  // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
  // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
  // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
  // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
  // this marker the hook would run the affected suite on the scheduled push and wedge
  // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
  // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', PAPERCUSP_GIT_SYNC_PUSH: '1' };
  if (gitSyncSidecarEnabled()) {
    try {
      return await runGitViaSpawnerSidecar(args, cwd, timeoutMs, env);
    } catch (e) {
      console.warn(`[git-sync] spawner-sidecar git fallback to local spawn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return runGitLocalBounded(args, cwd, timeoutMs);
};

/** Spawn `git <args>` in `cwd` with the default per-subcommand ceiling (never throws). */
const defaultRunGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));

/** GitHub hard-rejects blobs ≥100MB (pre-receive) — a committed oversized blob makes
 *  the whole unpushed range PERMANENTLY unpushable (EI-18: 10.4GB of Rust target/
 *  artifacts wedged the push for 20h). Stay safely under. */
export const DEFAULT_MAX_BLOB_BYTES = 95 * 1024 * 1024;

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
  /** Dirty files larger than this are EXCLUDED from the auto-commit and reported
   *  (`oversized` on the outcome) instead of wedging the push forever
   *  (default DEFAULT_MAX_BLOB_BYTES). */
  maxBlobBytes?: number;
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
/** A dirty file excluded from the auto-commit because it exceeds maxBlobBytes. */
export interface OversizedFile {
  path: string;
  sizeBytes: number;
}
/** An oversized file, qualified by which repo it sits in. */
export interface ScopedOversized extends OversizedFile {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}
/** A content-guard offender (EI-438), qualified by which repo it sits in. The
 *  action layer escalates these + dispatches a content-fixer (git-sync-action). */
export interface ScopedContentError extends ContentOffender {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}

/**
 * The aggregate result of one whole-repo pass. `pushed`/`merged` name the scopes
 * ('superproject' or submodule paths) that were pushed to / merged from origin, so
 * a caller can report exactly what moved. A pass NO LONGER stops at the first
 * conflict: it reconciles every submodule it can, COLLECTS conflicts/errors, and
 * only defers the superproject (see runGitSync). `status` is the worst outcome:
 * any conflict → 'conflict', else any error → 'error', else 'synced'/'nothing'.
 */
export type GitSyncOutcome = {
  /** Dirty files excluded from this pass's auto-commits for exceeding maxBlobBytes
   *  (EI-18). Non-empty = someone must gitignore/remove them — this NEVER self-heals;
   *  the caller escalates. Present on every status ('nothing' included: an
   *  oversized-only dirty tree commits nothing but still reports). */
  oversized: ScopedOversized[];
  /** Dirty files EXCLUDED from this pass's auto-commits because a content detector
   *  flagged them (EI-438 — e.g. an .mdx that won't compile). Like `oversized`, the
   *  rest of the tree still commits (D-001 quarantine-don't-stall); the action layer
   *  escalates these + dispatches a content-fixer, which self-heals on a later tick.
   *  Present on every status. */
  contentErrors: ScopedContentError[];
} & (
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: string[]; merged: string[] }
  | { status: 'conflict'; conflicts: RepoConflict[]; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'error'; errors: RepoError[]; pushed: string[]; merged: string[] }
);

/**
 * WI-1416: the seam a durable caller (git-sync-action inside a DBOS routineFire)
 * threads checkpointing through. Each pipeline PHASE (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) runs under `step(name, fn)` so the
 * workflow records one operation_output per phase: the executor reaper sees genuine
 * progress (function_id > 0), and a crashed/resumed fire REPLAYS completed phases
 * from their checkpoints instead of re-running them. Defaults to a passthrough
 * (unit tests / fireGitSyncNow outside any workflow).
 *
 * REPLAY SAFETY (the hard constraint): every phase is idempotent against a re-run —
 * a replayed commit finds a clean tree (`nothing to commit` is benign), a replayed
 * push is `Everything up-to-date`, a replayed merge re-fetches — so neither a DBOS
 * step retry nor a reaped-and-requeued fire can double-commit.
 */
export type GitSyncStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface RunGitSyncOpts {
  /** Override the repo path (tests); else resolved via `projectDirForSlug(slug)`. */
  repoPath?: string;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  /** WI-1416: run each pipeline phase as a checkpointed durable step (see
   *  GitSyncStepRunner). Default: plain passthrough execution. */
  step?: GitSyncStepRunner;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Repo-relative paths. */
  submodulePaths?: string[];
  /** Override the content-guard detector registry (tests / future extension).
   *  Defaults to DEFAULT_CONTENT_DETECTORS (mdx + smart-quotes). Pass [] to disable. */
  contentDetectors?: ContentDetector[];
  /** Read a repo-relative file's working-tree text for the content guard (tests).
   *  Defaults to fs read; null on any error. */
  readText?: (repoPath: string, relPath: string) => Promise<string | null>;
  log?: (m: string) => void;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): the caller supplies the live roster of active
   *  agents + their declared files (built flag-gated from coord presence). When present, git-sync
   *  derives a per-repo attribution map and peels per-agent commits; when absent (flag OFF / no
   *  caller) commits are unchanged (today's single whole-tree commit). DERIVED, never authored. */
  loadRoster?: () => Promise<AttributionRosterEntry[]>;
}

/** Default content-guard file reader — the working-tree bytes that `add -A` would
 *  commit; null on any error (gone/binary/permission) so the guard fails open. */
const defaultReadText = async (repoPath: string, relPath: string): Promise<string | null> => {
  try {
    return await readFile(join(repoPath, relPath), 'utf8');
  } catch {
    return null;
  }
};

const isDirty = async (runGit: RunGit, repo: string): Promise<boolean> => {
  const r = await runGit(['status', '--porcelain'], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
};

/** Current branch name, or null when HEAD is detached. */
const currentBranch = async (runGit: RunGit, repo: string): Promise<string | null> => {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The remote's default branch — `git rev-parse --abbrev-ref <remote>/HEAD` →
 *  "<remote>/main" → "main". Resolves the sync branch for a DETACHED HEAD (P-004):
 *  a fresh `git submodule update` leaves submodules detached, and they must sync to
 *  their OWN default (main), not the superproject's branch. Null when <remote>/HEAD
 *  isn't set. */
const remoteDefaultBranch = async (runGit: RunGit, repo: string, remote: string): Promise<string | null> => {
  const r = await runGit(['rev-parse', '--abbrev-ref', `${remote}/HEAD`], repo);
  if (r.code !== 0) return null;
  const ref = r.stdout.trim();
  if (!ref || ref.endsWith('/HEAD')) return null; // unset → the literal "<remote>/HEAD"
  return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
};

const headSha = async (runGit: RunGit, repo: string): Promise<string> => {
  const r = await runGit(['rev-parse', 'HEAD'], repo);
  return r.stdout.trim();
};

const conflictedFiles = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], repo);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

// Exported for the non-FF detection table test (test-coverage-gap G21): a git
// wording change must fail a test, not silently turn retriable rejections into
// hard escalations.
export function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/** A non-zero `git commit` that simply had nothing staged (e.g. every dirty file was
 *  excluded as oversized) — benign, NOT a real commit failure. Anything else (index.lock
 *  race, corrupt index, hook abort) IS a failure we must surface (P-002). */
function nothingToCommit(r: { stdout: string; stderr: string }): boolean {
  return /nothing to commit|no changes added to commit|nothing added to commit/i.test(`${r.stdout}\n${r.stderr}`);
}

/** Repo-relative paths that made `git add` FATAL because they are embedded git repos with no
 *  commit ("error: '<path>' does not have a commit checked out"). Extracted so git-sync can
 *  EXCLUDE them + retry rather than silently stranding the WHOLE tree (2026-06-30 root cause:
 *  one nested no-commit .git under .papercusp/.vitest-tmpdir fatal-ed `git add -A`, so nothing
 *  committed for ~7h). Exported for unit testing. */
export function addFailureStrayPaths(output: string): string[] {
  const out: string[] = [];
  const re = /error: '([^']+)' does not have a commit checked out/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out.push(m[1].replace(/\/+$/, '')); // git prints a trailing slash for a dir; pathspec wants it clean
  }
  return [...new Set(out)];
}

/** The `git add`/`git commit` fatal for a held index lock ("Unable to create
 *  '….git/index.lock': File exists"). Exported for unit testing (a git wording
 *  change must fail a test, not silently disable the self-heal below). */
export function isIndexLockFailure(output: string): boolean {
  return /Unable to create '[^']*index\.lock': File exists/i.test(output);
}

/** A lock YOUNGER than this is treated as live contention (git rewrites the lock
 *  file as it builds the new index, so an in-flight writer keeps the mtime fresh);
 *  older = the writer is dead and the lock is an orphan. git-sync ticks run ~2min
 *  apart, so a real writer is never this old between ticks. */
export const STALE_INDEX_LOCK_MS = 90_000;

/**
 * STALE-LOCK SELF-HEAL (2026-07-04): a git process killed mid-`add -A` leaves
 * `.git/index.lock` behind, and every subsequent tick then fails with the same
 * "File exists" fatal — FOREVER, until a human deletes the file (observed live:
 * 3 consecutive failed ticks + a fleet-wide alert for a 6.8MB orphaned lock).
 * This clears the lock ONLY when it is provably stale (mtime older than
 * `staleMs` — an active writer keeps it fresh), so a live racing git process is
 * never robbed of its lock; a fresh-lock failure stays an error and the NEXT
 * tick (by which time the orphan has aged past the threshold) heals it. Resolves
 * the git dir via `rev-parse --absolute-git-dir` so submodules (whose `.git` is
 * a file, not a dir) work too. Returns true when the caller should retry.
 */
export async function clearStaleIndexLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: {
    statMtimeMs?: (p: string) => Promise<number | null>;
    unlinkFile?: (p: string) => Promise<void>;
    now?: () => number;
    staleMs?: number;
  } = {},
): Promise<boolean> {
  const statMtimeMs =
    deps.statMtimeMs ??
    (async (p: string) => {
      try {
        return (await lstat(p)).mtimeMs;
      } catch {
        return null;
      }
    });
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), 'index.lock');
  const mtime = await statMtimeMs(lockPath);
  if (mtime === null) return true; // already gone (holder finished/cleaned up) — just retry
  const ageMs = now() - mtime;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: index.lock is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it; this tick fails and the next one self-heals if the writer died`,
    );
    return false;
  }
  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: could not unlink stale index.lock: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE index.lock (${Math.round(ageMs / 1000)}s old — its writer is dead) and retrying (previously: every tick failed until a human removed it)`,
  );
  return true;
}

/**
 * Recursively discover submodule paths (repo-relative), DEEPEST-FIRST. Dynamic —
 * reads the live submodule tree (`git submodule status --recursive`), never a
 * hardcoded list. Skips uninitialized submodules (leading '-'). Deepest-first so a
 * child lands on its origin before a parent's pointer to it is pushed.
 */
// Exported for the stray-gitlink fallback regression test (2026-07-01).
export const discoverSubmodulesRecursive = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
): Promise<string[]> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code === 0) {
    const paths = r.stdout
      .split('\n')
      .filter(Boolean)
      .filter((l) => l[0] !== '-') // skip uninitialized
      .map((l) => l.slice(1).trim().split(/\s+/)[1]) // "<flag><sha> <path> (<describe>)" → path
      .filter(Boolean);
    return paths.sort((a, b) => b.split('/').length - a.split('/').length);
  }
  // ONE stray index gitlink with no .gitmodules mapping (e.g. a test's temp repo swept in
  // by an auto-commit) makes `git submodule status --recursive` exit 128 — and a silent []
  // here strands EVERY submodule's commits, every tick, while the routine keeps reporting
  // "synced" (2026-07-01: `.papercusp/scratch/tmp/relgit-*` did exactly this for days).
  // Never silently skip the pass: SAY SO, then fall back to the .gitmodules mapping
  // (authoritative for top-level paths; nested submodules wait until the stray is removed —
  // `git rm --cached <stray-path>` is the operator fix, named in the log line).
  log(
    `[git-sync] submodule discovery FAILED (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
      `falling back to .gitmodules top-level paths; if this names a stray gitlink, fix with: git rm --cached <path>`,
  );
  const cfg = await runGit(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], repo);
  if (cfg.code !== 0) return [];
  const paths: string[] = [];
  for (const line of cfg.stdout.split('\n')) {
    const p = line.trim().split(/\s+/)[1];
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // initialized submodules only (worktree has .git)
      paths.push(p);
    } catch {
      /* uninitialized — skip */
    }
  }
  return paths.sort((a, b) => b.split('/').length - a.split('/').length);
};

/** One `git stash` entry, identified by its underlying commit SHA (stable across
 *  ticks — unlike `stash@{N}`, which is purely POSITIONAL and shifts whenever an
 *  older entry is popped/dropped). */
export interface StashEntry {
  sha: string;
  subject: string;
}

/**
 * WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared staging tree and it silently sat there looking like vanished work): list
 * one repo's current stash entries. Read-only, never throws — a `git stash list`
 * failure (odd env, detached/bare repo) reads as empty, same fail-open posture as
 * the other best-effort git-sync primitives in this file.
 */
export async function listStashEntries(runGit: RunGit, repoPath: string): Promise<StashEntry[]> {
  const r = await runGit(['stash', 'list', '--format=%H%x1f%s'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\x1f');
      return { sha, subject };
    })
    .filter((e) => e.sha.length > 0);
}

/** Pure: which of `current`'s stash entries were never in `knownShas` — i.e. genuinely
 *  NEW since the last check. Exported so the comparison logic is unit-testable with
 *  zero git subprocess involved (mirrors the other pure `*FromRows`/`*From*` helpers
 *  in this codebase). */
export function newStashEntries(current: StashEntry[], knownShas: readonly string[]): StashEntry[] {
  const known = new Set(knownShas);
  return current.filter((e) => !known.has(e.sha));
}

type RepoSyncResult = { oversized: OversizedFile[]; contentErrors: ContentOffender[] } & (
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string }
);

/**
 * Dirty (modified/untracked) files exceeding maxBytes — detected BEFORE `add -A` so
 * the auto-commit can EXCLUDE them (EI-18: GitHub hard-rejects >100MB blobs, and one
 * committed oversized blob makes the unpushed range permanently unpushable; recovery
 * is manual history surgery). Uses `status --porcelain -z` (NUL-separated, unquoted —
 * robust to spaces/specials in paths) with `-uall` (P-001): WITHOUT it a brand-new
 * directory collapses to a single `?? dir/` entry whose `lstat` is a directory and is
 * skipped, hiding an oversized file INSIDE it — then `add -A` commits it and wedges the
 * push forever (the exact EI-18 incident class). `-uall` lists every untracked file
 * individually so each oversized blob is seen + excluded.
 */
// Exported for the exact-boundary table test (test-coverage-gap G22): the size
// comparison is strict `>` — a file AT maxBytes must be INCLUDED, not excluded.
export async function findOversizedDirtyFiles(runGit: RunGit, repoPath: string, maxBytes: number): Promise<OversizedFile[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: OversizedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletions have no blob to size
    try {
      const st = await lstat(join(repoPath, path));
      if (st.isFile() && st.size > maxBytes) out.push({ path, sizeBytes: st.size });
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
    }
  }
  return out;
}

/** Enumerate every dirty path (modified/added/deleted/untracked), repo-relative, in the
 *  same path-space as the oversized/content excludes. `-z` keeps paths with spaces/newlines
 *  intact; a rename/copy origin path (the 2nd `-z` field) is skipped. Exported for P-004 tests. */
export async function dirtyFiles(runGit: RunGit, repoPath: string): Promise<string[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // -z rename/copy: skip the origin path that follows
    out.push(e.slice(3));
  }
  return out;
}

/** The CI-skip suffix git-sync's message carries (e.g. ` [skip ci]`), so every per-agent
 *  commit skips CI exactly like the catch-all. Empty when the message has no such marker. */
function skipCiSuffix(message: string): string {
  const m = message.match(/(\[skip ci\])\s*$/i);
  return m ? ` ${m[1]}` : '';
}

/**
 * P-004 (git-sync-dx-hardening): peel each declaring agent's dirty files into its OWN commit
 * (intent subject + a Co-Authored-By trailer), preserving the CI-skip marker. Excluded files
 * (oversized / content offenders) stay quarantined. The catch-all (agent=null) group is left
 * for the caller's existing whole-tree commit. Never throws; a real commit failure returns an
 * error. Exported for the P-004 commit-grouping test (injected runGit, no real repo).
 */
export async function commitAttributedGroups(
  runGit: RunGit,
  repoPath: string,
  attribution: Map<string, FileAttribution>,
  excludePaths: string[],
  message: string,
): Promise<{ committedAny: boolean; error?: string }> {
  const excludeSet = new Set(excludePaths);
  const dirty = (await dirtyFiles(runGit, repoPath)).filter((f) => !excludeSet.has(f));
  const groups = groupFilesForAttribution(dirty, attribution);
  const suffix = skipCiSuffix(message);
  let committedAny = false;
  for (const g of groups) {
    if (g.agent === null || g.files.length === 0) continue; // catch-all handled by the caller's add -A
    await runGit(['add', '--', ...g.files], repoPath);
    const args = ['commit', '--no-verify', '-m', `${g.subject}${suffix}`];
    if (g.coAuthor) args.push('-m', `Co-Authored-By: ${g.coAuthor}`);
    // P-004 (deterministic-commit-workitem-attribution-2026-06-22): bounded provenance
    // trailers so the commit↔work-item link travels IN git history (and is read back
    // post-sync into git_sync_commit_attribution). Deterministic — from the ledger-derived
    // attribution, no LLM (D-004/D-006).
    if (g.agent) args.push('-m', `Papercusp-Agent: ${g.agent}`);
    if (g.workItems && g.workItems.length > 0) {
      args.push('-m', `Papercusp-Work-Item: ${g.workItems.slice(0, 20).join(', ')}`);
    }
    if (g.sessionId) args.push('-m', `Papercusp-Session: ${g.sessionId}`);
    if (g.planSlug) args.push('-m', `Papercusp-Plan: ${g.planSlug}`);
    const c = await runGit(args, repoPath);
    if (c.code === 0) committedAny = true;
    else if (!nothingToCommit(c)) {
      return { committedAny, error: `attributed commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}` };
    }
  }
  return { committedAny };
}

/** The knobs the COMMIT half of one repo's sync needs (stage + content-guard + commit). */
interface CommitRepoOpts {
  message: string;
  maxBlobBytes: number;
  contentDetectors: ContentDetector[];
  readText: (repoPath: string, relPath: string) => Promise<string | null>;
  log: (m: string) => void;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): path→agent map for THIS repo. When present
   *  + non-empty, dirty files are peeled into per-agent commits first; the catch-all
   *  `git add -A` commit (today's behavior) sweeps the remainder. Absent/empty = byte-identical
   *  to today's single commit. */
  attribution?: Map<string, FileAttribution>;
}

/** JSON-serializable — checkpointed as the superproject `git-sync:pointer-bump` step output. */
interface CommitRepoResult {
  committedLocal: boolean;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  /** A REAL add/commit failure (index.lock race, corrupt index, embedded-repo fatal) —
   *  surfaced by the caller as a repo error. `nothing to commit` is NOT an error. */
  error?: string;
}

/**
 * WI-1416: the COMMIT half of one repo's sync — stage (`add -A` with oversized +
 * content-guard excludes) + commit. Replay-safe by construction: on an
 * already-committed (clean) tree it is a no-op (`nothing to commit` is benign), so
 * a durable-step re-run or a reaped-and-requeued fire cannot double-commit.
 */
async function commitOneRepo(runGit: RunGit, repoPath: string, o: CommitRepoOpts): Promise<CommitRepoResult> {
  const { message } = o;
  let committedLocal = false;
  let oversized: OversizedFile[] = [];
  let contentErrors: ContentOffender[] = [];
  if (await isDirty(runGit, repoPath)) {
    // EI-18 guard: never bake an unpushable blob into the range. Oversized dirty
    // files are excluded from the commit (`:(exclude,literal)` pathspecs) and
    // reported; everything else still syncs this tick.
    oversized = await findOversizedDirtyFiles(runGit, repoPath, o.maxBlobBytes);
    // EI-438 content guard (P-001/P-002, D-001): a dirty file that fails a content
    // detector (an .mdx that won't compile, a curly quote used as code) is EXCLUDED
    // from this commit and left dirty for the content-fixer — so one broken file
    // never stalls the rest of the tree's commit (quarantine, don't stall). Fails
    // OPEN: a throwing detector is skipped, never a blocker.
    contentErrors = await detectContentOffenders({
      runGit,
      repoPath,
      readText: (rel) => o.readText(repoPath, rel),
      detectors: o.contentDetectors,
      log: o.log,
    });
    // Exclude BOTH oversized + content offenders from the auto-commit (deduped — a
    // file can be both). Everything clean still syncs this tick.
    const excludePaths = [...new Set([...oversized.map((f) => f.path), ...contentErrors.map((c) => c.file)])];
    let committedAny = false;
    // P-004: when an attribution map is supplied (flag GIT_SYNC_DERIVED_ATTRIBUTION on), peel
    // each declaring agent's dirty files into its OWN commit (intent subject + Co-Authored-By)
    // BEFORE the catch-all. Absent/empty → no-op, so the flag-OFF path stays byte-identical.
    if (o.attribution && o.attribution.size > 0) {
      const res = await commitAttributedGroups(runGit, repoPath, o.attribution, excludePaths, message);
      if (res.error) {
        // STRANDING GUARD (2026-06-30): a failed per-agent attributed commit — e.g. an
        // index.lock race under heavy fleet contention — must NEVER short-circuit the
        // catch-all `git add -A` sweep below. Returning here strands the unattributed
        // REMAINDER: untracked NEW files (a new tool/module) whose `import` was already
        // committed in an earlier tick. The result is an UNBUILDABLE tree — "the agent's
        // code went missing", and every deploy preflight dies on `Cannot find module`.
        // Log it and FALL THROUGH; the catch-all commits everything still dirty (the
        // failed group's files + the remainder), so no file is ever left behind.
        o.log(
          `[git-sync] ${repoPath}: attributed-commit phase errored (${res.error}); falling through to the catch-all 'git add -A' sweep so no file strands`,
        );
      }
      committedAny = res.committedAny;
    }
    // Catch-all = today's single whole-tree commit: sweeps the unattributed remainder (or
    // EVERYTHING when no attribution), including anything a path-specific add missed (rename
    // origin-sides, etc.). Byte-identical to the pre-P-004 commit path.
    const buildAddArgs = (extraExcludes: string[]): string[] => {
      const ex = [...new Set([...excludePaths, ...extraExcludes])];
      return ex.length === 0 ? ['add', '-A'] : ['add', '-A', '--', '.', ...ex.map((p) => `:(exclude,literal)${p}`)];
    };
    // STRANDING GUARD (2026-06-30 ROOT CAUSE): a stray EMBEDDED git repo with no commit
    // ("error: '<path>' does not have a commit checked out") makes `git add -A` FATAL
    // (exit 128) → stages NOTHING → `git commit` reports "nothing" → the WHOLE tree strands
    // silently, every tick, for hours (a green-checkpoint test left a nested .git under
    // .papercusp/.vitest-tmpdir/). The add's exit code was previously UNCHECKED, so the fatal
    // was invisible. Now: check it; on that specific failure, parse the offending path(s),
    // EXCLUDE them, and retry ONCE so one stray repo can't strand everyone's work; if it STILL
    // fails, return a LOUD 'error' (caught by the git-sync-stall watchdog + escalation) instead
    // of silently reporting 'nothing'.
    let addRes = await runGit(buildAddArgs([]), repoPath);
    if (addRes.code !== 0) {
      const stray = addFailureStrayPaths(`${addRes.stdout}\n${addRes.stderr}`);
      if (stray.length > 0) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' FAILED on embedded/uncommitted repo(s) [${stray.join(', ')}] — excluding + retrying so the rest of the tree still commits (previously: silent strand)`,
        );
        addRes = await runGit(buildAddArgs(stray), repoPath);
      }
      // STALE-LOCK SELF-HEAL (2026-07-04): a dead git process's orphaned index.lock
      // otherwise fails EVERY tick until a human clears it. Provably-stale only —
      // see clearStaleIndexLock.
      if (addRes.code !== 0 && isIndexLockFailure(`${addRes.stdout}\n${addRes.stderr}`)) {
        const cleared = await clearStaleIndexLock(runGit, repoPath, o.log);
        if (cleared) addRes = await runGit(buildAddArgs(stray), repoPath);
      }
      if (addRes.code !== 0) {
        return {
          committedLocal: false,
          error: `git add -A failed — the tree would strand uncommitted: ${(addRes.stderr || addRes.stdout).trim().slice(0, 300)}`,
          oversized,
          contentErrors,
        };
      }
    }
    const c = await runGit(['commit', '--no-verify', '-m', message], repoPath);
    if (c.code === 0) {
      committedAny = true;
    } else if (!nothingToCommit(c)) {
      // P-002: a real commit failure (index.lock race, corrupt index, a hook) is NOT
      // a merge conflict. If the still-dirty tree fell through to the merge phase it
      // would abort as a phantom 'conflict' with zero conflicted files and dispatch a
      // merge-resolver at nothing, while the true failure (agents' work not landing)
      // stayed invisible. Surface it as an error.
      return {
        committedLocal: false,
        error: `commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}`,
        oversized,
        contentErrors,
      };
    }
    committedLocal = committedAny;
  }
  return { committedLocal, oversized, contentErrors };
}

/** JSON-serializable — checkpointed as the superproject `git-sync:push` step output. */
type ReconcilePushResult =
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string };

/**
 * WI-1416: the RECONCILE+PUSH half of one repo's sync — resolve branch → fetch →
 * merge (handles diverged/behind) → push (one non-FF retry). Replay-safe: a re-run
 * re-fetches and an already-pushed HEAD is `Everything up-to-date`.
 */
async function reconcileAndPushOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: { remote: string; defaultBranch: string; doPush: boolean; log: (m: string) => void },
  /** whether the commit half made a local commit this pass (drives the fetch-failure
   *  classification + the final nothing/synced verdict). */
  committedLocal: boolean,
): Promise<ReconcilePushResult> {
  const { remote, doPush } = o;
  // P-004: a detached HEAD (a fresh `git submodule update` leaves submodules detached)
  // must sync to the repo's OWN remote default branch (origin/HEAD → e.g. 'main'), NOT
  // the superproject's configured branch — o.defaultBranch carries 'staging' for the
  // live superproject, and using it for a detached submodule would push that submodule's
  // commits to the wrong branch and fail every tick with no clear cause. origin/HEAD
  // resolves the right branch; o.defaultBranch is only the last resort when even that is
  // unknown (and is now passed per-repo: 'main' for submodules, cfg.branch for the super).
  // P-011: HEAD's branch → the remote default (origin/HEAD) → the per-repo last-resort
  // default. If we reach the last resort the branch is a GUESS — make it LOUD (a wrong
  // guess would otherwise surface only as an opaque "push failed" escalation).
  const resolvedBranch =
    (await currentBranch(runGit, repoPath)) ?? (await remoteDefaultBranch(runGit, repoPath, remote));
  const branch = resolvedBranch ?? o.defaultBranch;
  if (!resolvedBranch) {
    o.log(
      `[git-sync] ${repoPath}: could not resolve a branch from HEAD or ${remote}/HEAD — falling back to '${o.defaultBranch}' (a wrong guess will fail the push; P-011)`,
    );
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
    const mergeOut = `${merge.stdout}\n${merge.stderr}`.trim();
    await runGit(['merge', '--abort'], repoPath); // clean tree
    // P-002: a failed merge with NO unmerged paths is not a content conflict a
    // merge-resolver can fix (e.g. "local changes would be overwritten", "not
    // something we can merge") — surface as error, don't dispatch a resolver at it.
    if (conflicted.length === 0) {
      return { status: 'error', message: `merge failed (no conflicted paths): ${mergeOut.slice(0, 300)}` };
    }
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
        const m2Out = `${m2.stdout}\n${m2.stderr}`.trim();
        await runGit(['merge', '--abort'], repoPath);
        if (conflicted.length === 0) {
          return { status: 'error', message: `merge failed (no conflicted paths): ${m2Out.slice(0, 300)}` };
        }
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
 * Sync ONE repo (superproject or a single submodule) to origin: commit dirty →
 * fetch → merge (reconciling a diverged/behind remote) → push. Never throws.
 * Composed from the two halves above (each independently checkpointable for the
 * superproject; submodules run both halves inside one phase step).
 */
async function syncOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts & { remote: string; defaultBranch: string; doPush: boolean },
): Promise<RepoSyncResult> {
  const c = await commitOneRepo(runGit, repoPath, o);
  if (c.error) {
    return { status: 'error', message: c.error, oversized: c.oversized, contentErrors: c.contentErrors };
  }
  const r = await reconcileAndPushOneRepo(runGit, repoPath, o, c.committedLocal);
  return { ...r, oversized: c.oversized, contentErrors: c.contentErrors };
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
  const maxBlobBytes = cfg.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const log = opts.log ?? (() => {});
  // WI-1416: the checkpoint seam — each phase below runs under `step` so a durable
  // caller records one operation_output per phase (see GitSyncStepRunner).
  const step: GitSyncStepRunner = opts.step ?? (async (_name, fn) => fn());
  // EI-438 content guard seams (default registry + fs reader; injectable for tests).
  const contentDetectors = opts.contentDetectors ?? DEFAULT_CONTENT_DETECTORS;
  const readText = opts.readText ?? defaultReadText;
  const repoO = { remote, message, doPush, maxBlobBytes, contentDetectors, readText, log };

  const repo = opts.repoPath ?? (await projectDirForSlug(slug));
  if (!repo) {
    return { status: 'error', errors: [{ scope: 'superproject', message: `no repo path registered for harness '${slug}'` }], pushed: [], merged: [], oversized: [], contentErrors: [] };
  }

  // P-004: the live roster (active agents + their declared files) for THIS tick, supplied by
  // the caller flag-gated. Empty when the flag is OFF (or no caller) → no attribution, today's
  // single-commit behavior. Read ONCE; per-repo maps are derived below (super + each submodule).
  const roster = opts.loadRoster ? await opts.loadRoster() : [];

  /** One phase's collected results — JSON-serializable so it checkpoints as a step output. */
  interface PhaseCollect {
    conflicts: RepoConflict[];
    errors: RepoError[];
    pushed: string[];
    merged: string[];
    oversized: ScopedOversized[];
    contentErrors: ScopedContentError[];
    didSomething: boolean;
  }
  const emptyPhase = (): PhaseCollect => ({
    conflicts: [], errors: [], pushed: [], merged: [], oversized: [], contentErrors: [], didSomething: false,
  });

  const absorb = (into: PhaseCollect, scope: string, r: RepoSyncResult): void => {
    if (r.oversized.length > 0) {
      into.oversized.push(...r.oversized.map((f) => ({ scope, ...f })));
      log(`[git-sync] ${scope}: EXCLUDED ${r.oversized.length} oversized file(s) from the auto-commit (${r.oversized.map((f) => `${f.path} ${(f.sizeBytes / 1048576).toFixed(1)}MB`).join(', ')}) — gitignore or remove them (${slug})`);
    }
    if (r.contentErrors.length > 0) {
      // EI-438 (D-001): broken files were EXCLUDED from this commit + left dirty for the
      // content-fixer; the rest of the tree still committed. Like oversized, this does
      // NOT defer the superproject (the (sub)repo's commit WITHOUT the broken file IS on
      // its origin, so the parent gitlink resolves).
      into.contentErrors.push(...r.contentErrors.map((c) => ({ scope, ...c })));
      log(`[git-sync] ${scope}: QUARANTINED ${r.contentErrors.length} broken file(s) from the auto-commit (${r.contentErrors.map((c) => `${c.file} [${c.detectorKey}]`).join(', ')}) — content-fixer dispatched (${slug})`);
    }
    if (r.status === 'conflict') {
      into.conflicts.push({ scope, conflictedFiles: r.conflictedFiles });
      log(`[git-sync] ${scope}: merge conflict (${r.conflictedFiles.join(', ')}) — aborted clean, continuing (${slug})`);
    } else if (r.status === 'error') {
      into.errors.push({ scope, message: r.message });
      log(`[git-sync] ${scope}: ${r.message} — continuing (${slug})`);
    } else if (r.status === 'synced') {
      into.didSomething = true;
      if (r.pushed) into.pushed.push(scope);
      if (r.merged) into.merged.push(scope);
    }
  };

  // PHASE `git-sync:submodules` — every submodule, deepest-first (dynamic recursive
  // discovery). Each is independent: a conflict/error in one is collected; the rest
  // still sync. Runs as ONE checkpointed step: the expensive multi-repo half of the
  // pass, after which a resumed fire never re-commits/re-pushes the submodules.
  const sub = await step('git-sync:submodules', async (): Promise<PhaseCollect> => {
    const out = emptyPhase();
    let subPaths: string[] = [];
    if (doSub) {
      subPaths = opts.submodulePaths
        ? [...opts.submodulePaths].sort((a, b) => b.split('/').length - a.split('/').length)
        : await discoverSubmodulesRecursive(runGit, repo, log);
    }
    for (const s of subPaths) {
      // P-004: a submodule's last-resort default is its own 'main' (resolved via
      // origin/HEAD first), never the superproject's branch (cfg.branch = 'staging').
      absorb(out, s, await syncOneRepo(runGit, join(repo, s), { ...repoO, defaultBranch: 'main', attribution: attributionMapForRepo(roster, s, repo) }));
    }
    return out;
  });

  // Superproject last — ONLY when every submodule reconciled (else its bumped pointers
  // would reference unpushed submodule commits). One unreconciled submodule defers it.
  // (Oversized exclusions do NOT defer it: the submodule's commit — without the big
  // file — IS on its origin, so the parent gitlink resolves fine.)
  const supr = emptyPhase();
  let superHeadSha: string | undefined;
  const blocked = sub.conflicts.length > 0 || sub.errors.length > 0;
  if (!blocked) {
    // PHASE `git-sync:pointer-bump` — superproject stage + content-guard + commit
    // (this commit is what bakes the bumped submodule pointers in).
    const commitRes = await step('git-sync:pointer-bump', () =>
      commitOneRepo(runGit, repo, { ...repoO, attribution: attributionMapForRepo(roster, '', repo) }));
    let repoResult: RepoSyncResult;
    if (commitRes.error) {
      repoResult = { status: 'error', message: commitRes.error, oversized: commitRes.oversized, contentErrors: commitRes.contentErrors };
    } else {
      // PHASE `git-sync:push` — superproject fetch + merge + push (the network half).
      const pushRes = await step('git-sync:push', async () => ({
        ...(await reconcileAndPushOneRepo(runGit, repo, { ...repoO, defaultBranch: branch }, commitRes.committedLocal)),
        headSha: await headSha(runGit, repo),
      }));
      superHeadSha = pushRes.headSha;
      repoResult = { ...pushRes, oversized: commitRes.oversized, contentErrors: commitRes.contentErrors };
    }
    absorb(supr, 'superproject', repoResult);
  } else {
    log(`[git-sync] ${sub.conflicts.length} conflict(s) + ${sub.errors.length} error(s) in submodules — deferring superproject push (${slug})`);
  }

  const conflicts = [...sub.conflicts, ...supr.conflicts];
  const errors = [...sub.errors, ...supr.errors];
  const pushed = [...sub.pushed, ...supr.pushed];
  const merged = [...sub.merged, ...supr.merged];
  const oversized = [...sub.oversized, ...supr.oversized];
  const contentErrors = [...sub.contentErrors, ...supr.contentErrors];
  const didSomething = sub.didSomething || supr.didSomething;

  if (conflicts.length > 0) return { status: 'conflict', conflicts, errors, pushed, merged, oversized, contentErrors };
  if (errors.length > 0) return { status: 'error', errors, pushed, merged, oversized, contentErrors };
  if (!didSomething) return { status: 'nothing', oversized, contentErrors };
  // superHeadSha comes from the push step's checkpoint; a 'synced' verdict implies that
  // step ran (blocked/commit-error passes return above). Fallback read for safety only.
  return { status: 'synced', headSha: superHeadSha ?? (await headSha(runGit, repo)), pushed, merged, oversized, contentErrors };
}
