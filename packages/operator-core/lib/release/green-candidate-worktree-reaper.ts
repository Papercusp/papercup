/**
 * green-candidate-worktree-reaper — WI-488635.
 *
 * THE LEAK: green-checkpoint creates a per-candidate worktree
 * `<integrationRoot>/.papercusp/worktrees/green-candidate-<pipeline>-<sha12>`
 * (green-checkpoint.ts:7756, :8338, :9134) and removes it ONLY through
 * `cleanupFrozenRepairWorktree` on the verification-only, fossil-reconcile and
 * post-advance paths. A run that dies before reaching one of those — crash, kill,
 * timeout, host restart — leaves the whole tree behind forever. Measured
 * 2026-08-28: 13 abandoned trees, 33 GiB, across five checkouts, the oldest 8 days.
 *
 * WHY IT IS EXPENSIVE OUT OF PROPORTION TO ITS SIZE: `report-cargo-tests` refuses to
 * spawn Cargo unless the filesystem has >=10% free OR >=128 GiB absolute headroom. The
 * leak walks the box across that line, and the refusal is a PRE-SPAWN admission failure,
 * so every affected-tests run on the host silently drops its Rust coverage and still
 * reports success. The disk cost is the mechanism; the lost test signal is the damage.
 *
 * WHY NOTHING ELSE CATCHES IT (checked repo-wide with a positive control, not by name):
 *   - `storage/prune.ts` trims PG categories and SESSION DIRS; its "candidates" are
 *     `discoverSessionDirCandidates`, an unrelated population.
 *   - `worktree-coverage-watchdog.ts` walks `.papercusp/worktrees` but is a DETECTOR of
 *     uncommitted work, and it explicitly allowlists that path as deliberately-covered —
 *     so the one watchdog that sees this directory is structurally blind to the leak.
 *   - Every other live `git worktree remove|prune` belongs to a different namespace
 *     (feature worktrees, orchestrator scratch-env) or to retired/built code.
 *
 * SHAPE: a PURE planner (every safety rule lives here, so the rules are unit-testable
 * without a filesystem) plus a thin executor behind injected seams. The executor is
 * deliberately non-fatal — reclaiming disk must never be able to wedge the gate it runs
 * inside.
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimum age before an abandoned candidate worktree may be reaped.
 *
 * Sized so that WIRING POSITION CANNOT CAUSE A MISTAKE: the gate fires hourly and a full
 * suite runs ~55 minutes, so a tree belonging to any in-flight run is far younger than
 * this floor and is unreachable by the reaper no matter where the sweep is called from.
 * `activeWorktreePaths` is the precise guard; this is the one that holds when the caller
 * passes an incomplete active set.
 */
export const DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** A directory found under `<integrationRoot>/.papercusp/worktrees`. */
export interface CandidateWorktreeEntry {
  /** Directory basename, e.g. `green-candidate-papercusp-f369131625d4`. */
  name: string;
  /** Absolute path to the directory. */
  path: string;
  /** Directory mtime, used for the age floor. */
  mtimeMs: number;
}

/** Why the reaper refused to reap an entry. Reported, never silent. */
export type CandidateWorktreePreserveReason =
  /** Name is not a `green-candidate-<pipeline>-<sha12>` directory — not ours to delete. */
  | 'unrecognized-name'
  /** The caller named this tree as belonging to a live candidate/queue. */
  | 'active-candidate'
  /** Younger than the age floor; a run may still be using it. */
  | 'too-young'
  /**
   * It was reapable when the directory was SCANNED and is not any more — a peer began
   * working inside it in between. Raised only by the executor's at-delete re-check.
   */
  | 'became-active-since-scan';

export interface CandidateWorktreeReapPlan {
  reap: CandidateWorktreeEntry[];
  preserved: Array<{
    entry: CandidateWorktreeEntry;
    reason: CandidateWorktreePreserveReason;
  }>;
}

/**
 * True when `name` is a candidate worktree this reaper owns.
 *
 * Deliberately strict: `<pipeline>` must match the pipeline whose root we are sweeping and
 * the suffix must be a 12-char lowercase hex abbreviated sha. Anything else — an operator's
 * scratch directory, a migration/synthesis isolation tree, a half-typed path — is left
 * alone. This is what stops the reaper from ever being a general-purpose `rm -rf`.
 */
export function isCandidateWorktreeName(name: string, pipeline: string): boolean {
  const prefix = `green-candidate-${pipeline}-`;
  if (!name.startsWith(prefix)) return false;
  return /^[0-9a-f]{12}$/.test(name.slice(prefix.length));
}

/**
 * Decide which candidate worktrees are safe to reclaim. Pure — no fs, no clock, no exec.
 *
 * Rules are applied in order and every refusal is reported with its reason, so a caller can
 * log "preserved X because it is the active candidate" rather than silently doing nothing.
 */
export function planCandidateWorktreeReap(opts: {
  entries: readonly CandidateWorktreeEntry[];
  pipeline: string;
  /** Trees known to belong to a live candidate or repair queue. Never reaped. */
  activeWorktreePaths?: readonly string[];
  nowMs: number;
  minAgeMs?: number;
}): CandidateWorktreeReapPlan {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS;
  const active = new Set(
    (opts.activeWorktreePaths ?? [])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => path.resolve(p)),
  );

  const plan: CandidateWorktreeReapPlan = { reap: [], preserved: [] };
  for (const entry of opts.entries) {
    if (!isCandidateWorktreeName(entry.name, opts.pipeline)) {
      plan.preserved.push({ entry, reason: 'unrecognized-name' });
      continue;
    }
    if (active.has(path.resolve(entry.path))) {
      plan.preserved.push({ entry, reason: 'active-candidate' });
      continue;
    }
    if (opts.nowMs - entry.mtimeMs < minAgeMs) {
      plan.preserved.push({ entry, reason: 'too-young' });
      continue;
    }
    plan.reap.push(entry);
  }
  return plan;
}

/** Enumerate the candidate worktree directories under an integration root. */
export function listCandidateWorktrees(integrationRoot: string): CandidateWorktreeEntry[] {
  const dir = path.join(integrationRoot, '.papercusp', 'worktrees');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No worktrees directory yet is the normal empty case, not an error.
    return [];
  }
  const entries: CandidateWorktreeEntry[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      entries.push({ name, path: full, mtimeMs: st.mtimeMs });
    } catch {
      // Raced with another remover — nothing to reap.
    }
  }
  return entries;
}

export interface CandidateWorktreeReapDeps {
  /**
   * `git -C <integrationRoot> worktree remove --force <path>`. Resolve `ok:false` (do not
   * throw) when git refuses — the caller falls back to a plain directory removal, which is
   * the ONLY thing that clears an admin-orphaned tree (a directory whose `.git` file is
   * gone is invisible to `git worktree remove`, and 7 of the 13 leaked trees were exactly
   * that).
   */
  gitWorktreeRemove(worktreePath: string): Promise<{ ok: boolean; detail?: string }>;
  /** Recursive directory removal, for admin-orphaned trees. */
  removeDirectory(worktreePath: string): Promise<void>;
  /** `git -C <integrationRoot> worktree prune` — drops admin entries for removed dirs. */
  gitWorktreePrune(): Promise<void>;
  log(message: string): void;
  /** Defaults to a real `existsSync` check for the worktree's `.git`. */
  hasGitDir?(worktreePath: string): boolean;
  /**
   * Last-moment re-check, run IMMEDIATELY before each removal. Return false to spare the
   * tree.
   *
   * WHY THIS EXISTS AND WHY THE AGE FLOOR DOES NOT REPLACE IT (measured 2026-08-28,
   * EI-21714994180505750): worktree `green-candidate-papercusp-228840fcdc13` read
   * dirtyTracked=0 at 16:21Z and dirtyTracked=14 at 16:25Z — a repair agent had begun
   * editing 16 source files inside it. A plan is a SNAPSHOT, and for a destructive action
   * four minutes of staleness is enough to destroy live work.
   *
   * Critically, the `minAgeMs` floor CANNOT catch this: a directory's mtime only changes
   * when its own entries are added or removed, so a peer editing files deep inside a tree
   * leaves the top-level mtime untouched and the tree still reads as old. Age answers "when
   * was this created", never "is somebody in it right now". Only a content re-check does.
   *
   * Omitted ⇒ no re-check (correct for a caller that has already frozen the directory).
   */
  confirmStillAbandoned?(worktreePath: string): Promise<boolean>;
}

export interface CandidateWorktreeReapResult {
  removed: string[];
  failed: Array<{ path: string; detail: string }>;
  preserved: Array<{ path: string; reason: CandidateWorktreePreserveReason }>;
  prunedAdmin: boolean;
}

/**
 * Execute a reap plan. Never throws: a reclaim failure is reported, not raised, because
 * this runs inside the release gate and freeing disk must not be able to fail the gate.
 */
export async function executeCandidateWorktreeReap(
  plan: CandidateWorktreeReapPlan,
  deps: CandidateWorktreeReapDeps,
): Promise<CandidateWorktreeReapResult> {
  const hasGitDir =
    deps.hasGitDir ?? ((worktreePath: string) => existsSync(path.join(worktreePath, '.git')));
  const result: CandidateWorktreeReapResult = {
    removed: [],
    failed: [],
    preserved: plan.preserved.map((p) => ({ path: p.entry.path, reason: p.reason })),
    prunedAdmin: false,
  };

  for (const entry of plan.reap) {
    try {
      // Re-verify at the MOMENT of deletion, never on the scan. See confirmStillAbandoned.
      if (deps.confirmStillAbandoned && !(await deps.confirmStillAbandoned(entry.path))) {
        result.preserved.push({ path: entry.path, reason: 'became-active-since-scan' });
        deps.log(
          `preserved ${entry.name}: a peer began working in it between the scan and the delete`,
        );
        continue;
      }
      let removed = false;
      if (hasGitDir(entry.path)) {
        const outcome = await deps.gitWorktreeRemove(entry.path);
        removed = outcome.ok;
        if (!outcome.ok && outcome.detail) {
          deps.log(
            `warn: git worktree remove refused ${entry.name} (${outcome.detail}); falling back to directory removal`,
          );
        }
      }
      if (!removed) await deps.removeDirectory(entry.path);
      result.removed.push(entry.path);
    } catch (error) {
      result.failed.push({
        path: entry.path,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.removed.length > 0) {
    try {
      await deps.gitWorktreePrune();
      result.prunedAdmin = true;
    } catch (error) {
      // Stale admin entries are harmless — the next `worktree add` re-prunes.
      deps.log(
        `warn: git worktree prune failed after reaping ${result.removed.length} tree(s): ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  return result;
}

/**
 * Compact `reason=count` histogram of a sweep's refusals, ordered by descending count then
 * reason name so the line is stable enough to diff across consecutive runs.
 */
export function summarizeCandidateWorktreePreservations(
  preserved: readonly { reason: CandidateWorktreePreserveReason }[],
): string {
  const counts = new Map<CandidateWorktreePreserveReason, number>();
  for (const p of preserved) counts.set(p.reason, (counts.get(p.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
}

/**
 * The lines a sweep should emit. Pure, so the OBSERVABILITY is testable without touching a
 * filesystem — which is the whole point of it existing separately from the entry point.
 *
 * WI-954677 / EI-21844531592346894: a sweep MUST account for itself on every pass, including
 * — especially — the pass where it removes nothing.
 *
 * Until now the only log fired when `removed.length > 0`, and the nothing-to-reap path
 * returned early in silence. `preserved` carries a reason per tree and its type is documented
 * "Reported, never silent", but the report was computed and then dropped on the floor. The
 * consequences were not hypothetical:
 *
 *  - Candidate worktrees filled the host to 94% with no surface showing the sweep refusing
 *    them, so the accumulation was first misdiagnosed as an active per-minute "drain" and the
 *    proposed remedy was killing other agents' in-flight suites.
 *  - A correct reading of this module concluded it had no production caller at all, because
 *    nothing anywhere evidenced it had ever run.
 *  - A reap that FAILED was indistinguishable from one that had nothing to do: `failed` was
 *    populated and discarded, so a persistently failing reclaim could never surface.
 *
 * A silent success and a silent no-op are the same observation, which is why this is not
 * merely nice-to-have logging.
 */
export function candidateWorktreeSweepLogLines(
  plan: CandidateWorktreeReapPlan,
  result: CandidateWorktreeReapResult | null,
): string[] {
  // Prefer the executed result: its `preserved` includes at-delete re-check refusals
  // (`became-active-since-scan`) that the plan alone cannot know about.
  const preserved = result?.preserved ?? plan.preserved;
  const removed = result?.removed ?? [];
  const failed = result?.failed ?? [];

  // `failed` MUST participate in this emptiness test. Omitting it reported "no candidate
  // worktrees present" while a reclaim was actively failing — the same silence this function
  // exists to end, reproduced inside the fix for it. Caught by its own guard below.
  if (preserved.length === 0 && removed.length === 0 && failed.length === 0) {
    return ['candidate-worktree sweep: no candidate worktrees present'];
  }

  let head = `candidate-worktree sweep: reaped ${removed.length}, preserved ${preserved.length}`;
  if (failed.length > 0) head += `, failed ${failed.length}`;
  if (preserved.length > 0) {
    head += ` (${summarizeCandidateWorktreePreservations(preserved)})`;
  }
  if (removed.length > 0) {
    head += `: ${removed.map((p) => path.basename(p)).join(', ')}`;
  }

  const lines = [head];
  for (const failure of failed) {
    lines.push(
      `warn: candidate-worktree sweep could not reclaim ${path.basename(failure.path)}: ${failure.detail}`,
    );
  }
  return lines;
}

/**
 * Sweep abandoned candidate worktrees under `integrationRoot`. Convenience wrapper that
 * enumerates, plans and executes; returns null when there was nothing to reap.
 *
 * Always logs exactly what it did and why, via `candidateWorktreeSweepLogLines`.
 */
export async function reapAbandonedCandidateWorktrees(opts: {
  integrationRoot: string;
  pipeline: string;
  activeWorktreePaths?: readonly string[];
  nowMs?: number;
  minAgeMs?: number;
  deps: CandidateWorktreeReapDeps;
}): Promise<CandidateWorktreeReapResult | null> {
  const plan = planCandidateWorktreeReap({
    entries: listCandidateWorktrees(opts.integrationRoot),
    pipeline: opts.pipeline,
    activeWorktreePaths: opts.activeWorktreePaths,
    nowMs: opts.nowMs ?? Date.now(),
    minAgeMs: opts.minAgeMs,
  });
  const result =
    plan.reap.length === 0 ? null : await executeCandidateWorktreeReap(plan, opts.deps);
  for (const line of candidateWorktreeSweepLogLines(plan, result)) opts.deps.log(line);
  return result;
}
