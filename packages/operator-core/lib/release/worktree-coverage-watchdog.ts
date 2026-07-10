/**
 * worktree-coverage-watchdog — WI-3612 (EI-8820 follow-up sweep, item #2): detect a git
 * worktree that is carrying uncommitted edits but that NO git-sync routine (or documented
 * intentional exclusion) covers.
 *
 * THE GAP this closes: EI-8820 found + fixed the ACUTE bug (a `PreToolUse` guard now BLOCKS
 * an agent edit that resolves to a non-canonical linked worktree — see
 * `apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh`), but that guard only stops a
 * FUTURE edit from landing there; nothing detects a worktree that ALREADY has dirty state no
 * routine will ever commit. WI-3449 (2026-07-09, settings-page audit) was stranded for hours
 * this exact way — an agent worked inside the linked `env-trees/staging` worktree, and only a
 * peer noticing the feature "never landed" caught it.
 *
 * WHAT COUNTS AS COVERED, three ways (checked in order):
 *   1. It IS the canonical tree itself (git-sync's own commit target).
 *   2. Its path matches a documented, deliberately-uncovered pattern — the repo's own
 *      workspace map (`system/repo-conventions` + this repo's CLAUDE.md) names these
 *      explicitly: `-release` / `-checkpoint` suffixed sibling trees (reset + swept every
 *      deploy/checkpoint run — dirty state there is EXPECTED, not stranded work), the
 *      `env-trees/<id>` D-006 env-operator serving trees (`env-tree-prepare.ts` — force-
 *      recreatable from `origin/<branch>` on every provision, deliberately never committed),
 *      and `.papercusp/worktrees/<slug>` migration/synthesis isolation trees (their OWN
 *      dedicated sync path, not git-sync's).
 *   3. Nothing else. A dirty worktree that matches NEITHER of the above is a genuine finding
 *      — most likely a stray worktree an agent created (or worked inside) that no routine will
 *      ever commit, i.e. exactly the WI-3449 class.
 *
 * Cheap by design (WI-3612 asked for a "cheap recurring check"): no DB round-trip, no
 * install_slug→path resolution — it shells `git worktree list --porcelain` from the canonical
 * tree (which enumerates every linked worktree of THIS repo) and `git status --porcelain` on
 * each, so it is O(worktrees), typically single digits. Process-level (`managedSetInterval`,
 * matching the git-sync-stall-watchdog / green-stall-watchdog siblings) — best-effort, must
 * never fail boot, logs + notifies on a genuine finding rather than paging urgently (this is a
 * "someone should look" signal, not a "code is stranding right now" page).
 *
 * Kill-switch: PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG='0'.
 */
import { execFile } from 'node:child_process';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

export interface WorktreeInfo {
  /** Absolute worktree path, as reported by `git worktree list --porcelain`. */
  path: string;
  /** True when `git status --porcelain` reports ≥1 line for this worktree (uncommitted
   *  changes, staged or not — tracked or untracked). */
  dirty: boolean;
  /** Number of `git status --porcelain` lines, for a more informative log line. */
  dirtyFileCount: number;
}

/**
 * Deliberately-excluded path patterns — kept as REGEXES (not exact strings) so they match
 * regardless of which sibling-repo layout / workspace root a given install uses (this repo's
 * own siblings are `papercup-release`/`papercup-checkpoint`/`papercusp-checkpoint`, but the
 * pattern intentionally isn't pinned to those exact names — see the class of trees named in
 * repo-conventions § workspace map + this file's header comment). Exported so the detector's
 * behavior is independently documented + testable, not buried in the classifier.
 */
export const KNOWN_UNCOVERED_WORKTREE_PATTERNS: readonly RegExp[] = [
  // Deploy artifact / green-checkpoint test trees — reset + swept every run by design.
  /-release(\/|$)/,
  /-checkpoint(\/|$)/,
  // D-006 env-operator serving trees (env-tree-prepare.ts) — force-recreated from
  // origin/<branch> on every provision; never meant to be committed.
  /\.papercusp(-workspaces\/[^/]+\/\.papercusp)?\/env-trees\//,
  // Migration/synthesis isolation worktrees — their OWN dedicated sync path.
  /\.papercusp\/worktrees\//,
];

/**
 * Pure: classify which of `worktrees` are UNCOVERED — dirty, not the canonical tree, and not
 * matching a documented exclusion pattern. Exported for unit testing without real git.
 */
export function findUncoveredDirtyWorktrees(
  worktrees: readonly WorktreeInfo[],
  canonicalPath: string,
  patterns: readonly RegExp[] = KNOWN_UNCOVERED_WORKTREE_PATTERNS,
): WorktreeInfo[] {
  return worktrees.filter((wt) => {
    if (!wt.dirty) return false;
    if (wt.path === canonicalPath) return false;
    return !patterns.some((re) => re.test(wt.path));
  });
}

export interface WorktreeCoverageDeps {
  /** Run a git command in `cwd`, returning stdout (throws on non-zero exit). Injected for
   *  tests; default shells out via execFile. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  log?: (message: string) => void;
}

function defaultRunGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString());
    });
  });
}

/** Parse `git worktree list --porcelain` output into the set of absolute worktree paths. */
export function parseWorktreeListPorcelain(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/**
 * Enumerate every linked worktree of the repo containing `canonicalPath`, with each one's
 * dirty state. Best-effort per-worktree: a worktree whose `git status` fails (e.g. deleted
 * off disk since `worktree list` last ran) is skipped rather than failing the whole scan.
 */
export async function listWorktreesWithDirtyState(
  canonicalPath: string,
  deps: WorktreeCoverageDeps = {},
): Promise<WorktreeInfo[]> {
  const runGit = deps.runGit ?? defaultRunGit;
  const listOut = await runGit(['worktree', 'list', '--porcelain'], canonicalPath);
  const paths = parseWorktreeListPorcelain(listOut);
  const results: WorktreeInfo[] = [];
  for (const path of paths) {
    try {
      const statusOut = await runGit(['status', '--porcelain'], path);
      const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
      results.push({ path, dirty: lines.length > 0, dirtyFileCount: lines.length });
    } catch {
      // Worktree vanished / inaccessible since `worktree list` ran — not this watchdog's
      // concern (a missing tree can't strand uncommitted work); skip it.
    }
  }
  return results;
}

export interface WorktreeCoverageCheckResult {
  uncovered: WorktreeInfo[];
}

/**
 * One watchdog pass: list worktrees, classify, log + best-effort notify on any genuine
 * finding. Never throws (mirrors the git-sync-stall-watchdog / green-stall-watchdog
 * process-level siblings — a detector must not be able to crash the host it watches).
 */
export async function checkWorktreeCoverage(
  canonicalPath: string,
  deps: WorktreeCoverageDeps = {},
): Promise<WorktreeCoverageCheckResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const worktrees = await listWorktreesWithDirtyState(canonicalPath, deps);
    const uncovered = findUncoveredDirtyWorktrees(worktrees, canonicalPath);
    if (uncovered.length > 0) {
      const detail = uncovered.map((w) => `${w.path} (${w.dirtyFileCount} dirty)`).join('; ');
      // A log line, not a notifyAttention() push/SSE alert: this is a "someone should
      // look eventually" signal (drift that accumulates over hours), not an urgent page —
      // notifyAttention's own doc reserves its 'needs-human' kind for ≥high-importance
      // items, which this genuinely isn't. The operator log + this function's return
      // value (a caller — an admin diagnostic route, a future scheduled digest — can
      // surface it more visibly) are the right-weight channel for a cheap, infrequent
      // sweep like this one.
      log(
        `[worktree-coverage-watchdog] ${uncovered.length} worktree(s) carry uncommitted edits ` +
          `no known routine/exclusion covers — likely stranded work (WI-3449 class): ${detail}`,
      );
    }
    return { uncovered };
  } catch (e) {
    log(`[worktree-coverage-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return { uncovered: [] };
  }
}

let watchdogTimer: ManagedHandle | null = null;

/** Default sweep cadence — this is a "someone should look" signal, not an urgent page, and
 *  the condition it catches (an agent working inside a stray worktree) develops over at least
 *  minutes-to-hours, so an hourly sweep is ample per WI-3612's "cheap" ask. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG='0'.
 */
export function startWorktreeCoverageWatchdog(
  canonicalPath: string,
  opts: WorktreeCoverageDeps & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = (): void => {
    void checkWorktreeCoverage(canonicalPath, opts);
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('worktree-coverage-watchdog', intervalMs, run, { category: 'watchdog' });
}
