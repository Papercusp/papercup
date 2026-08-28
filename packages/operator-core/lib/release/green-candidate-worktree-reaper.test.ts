/**
 * WI-488635 — guards for the abandoned green-candidate worktree reaper.
 *
 * The failure mode these tests exist to prevent is NOT "the reaper does not delete enough".
 * It is a reaper that deletes a tree a live gate run is still using, or that wanders outside
 * the `green-candidate-<pipeline>-<sha12>` namespace and removes something it does not own.
 * So every "preserved" assertion below is paired with a CALIBRATION case proving the reaper
 * would otherwise have reaped that exact entry — without it, a reaper that never reaps
 * anything would pass the whole preserve suite.
 */
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS,
  executeCandidateWorktreeReap,
  isCandidateWorktreeName,
  planCandidateWorktreeReap,
  type CandidateWorktreeEntry,
  type CandidateWorktreeReapDeps,
} from './green-candidate-worktree-reaper';

const ROOT = '/repo/.papercusp/worktrees';
const NOW = 1_800_000_000_000;
const OLD = NOW - DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS - 60_000;

function entry(name: string, mtimeMs = OLD): CandidateWorktreeEntry {
  return { name, path: path.join(ROOT, name), mtimeMs };
}

function plan(
  entries: CandidateWorktreeEntry[],
  extra: Partial<Parameters<typeof planCandidateWorktreeReap>[0]> = {},
) {
  return planCandidateWorktreeReap({
    entries,
    pipeline: 'papercusp',
    nowMs: NOW,
    ...extra,
  });
}

describe('planCandidateWorktreeReap', () => {
  it('CALIBRATION: reaps an old, inactive, correctly-named candidate worktree', () => {
    // If this ever fails, every "preserved" expectation below becomes vacuous.
    const abandoned = entry('green-candidate-papercusp-f369131625d4');
    const result = plan([abandoned]);
    expect(result.reap.map((e) => e.name)).toEqual(['green-candidate-papercusp-f369131625d4']);
    expect(result.preserved).toEqual([]);
  });

  it('preserves the ACTIVE candidate worktree — the live-run guard', () => {
    const live = entry('green-candidate-papercusp-f369131625d4');
    const result = plan([live], { activeWorktreePaths: [live.path] });
    expect(result.reap).toEqual([]);
    expect(result.preserved).toEqual([{ entry: live, reason: 'active-candidate' }]);
  });

  it('matches the active path through non-normalized forms', () => {
    const live = entry('green-candidate-papercusp-f369131625d4');
    const result = plan([live], {
      activeWorktreePaths: [`${ROOT}/./green-candidate-papercusp-f369131625d4`],
    });
    expect(result.reap).toEqual([]);
  });

  it('preserves a tree younger than the age floor — the in-flight guard', () => {
    const young = entry('green-candidate-papercusp-aaaaaaaaaaaa', NOW - 60_000);
    const result = plan([young]);
    expect(result.reap).toEqual([]);
    expect(result.preserved).toEqual([{ entry: young, reason: 'too-young' }]);
  });

  it('CONTROL: the same tree IS reaped once it crosses the age floor', () => {
    const name = 'green-candidate-papercusp-aaaaaaaaaaaa';
    expect(plan([entry(name, NOW - 60_000)]).reap).toEqual([]);
    expect(plan([entry(name, OLD)]).reap.map((e) => e.name)).toEqual([name]);
  });

  it('never touches a directory outside the candidate namespace', () => {
    // A migration/synthesis isolation tree and an operator scratch dir share this parent.
    const foreign = [
      entry('migration-841'),
      entry('synthesis-abc'),
      entry('green-candidate-scout-runtime-cfccc02cba94'), // different pipeline
      entry('green-candidate-papercusp-NOTAHEXSHA'),
      entry('green-candidate-papercusp-f36913'), // too short to be a sha12
    ];
    const result = plan(foreign);
    expect(result.reap).toEqual([]);
    expect(result.preserved.map((p) => p.reason)).toEqual(
      new Array(foreign.length).fill('unrecognized-name'),
    );
  });

  it('reaps only the abandoned trees from a mixed directory', () => {
    const live = entry('green-candidate-papercusp-f369131625d4');
    const entries = [
      live,
      entry('green-candidate-papercusp-2d3106addae0'),
      entry('green-candidate-papercusp-bbbbbbbbbbbb', NOW - 60_000),
      entry('migration-841'),
    ];
    const result = plan(entries, { activeWorktreePaths: [live.path] });
    expect(result.reap.map((e) => e.name)).toEqual(['green-candidate-papercusp-2d3106addae0']);
    expect(result.preserved.map((p) => p.reason).sort()).toEqual([
      'active-candidate',
      'too-young',
      'unrecognized-name',
    ]);
  });
});

describe('isCandidateWorktreeName', () => {
  it('accepts only <pipeline>-scoped sha12 directories', () => {
    expect(isCandidateWorktreeName('green-candidate-papercusp-f369131625d4', 'papercusp')).toBe(
      true,
    );
    expect(isCandidateWorktreeName('green-candidate-papercusp-F369131625D4', 'papercusp')).toBe(
      false,
    );
    expect(isCandidateWorktreeName('green-candidate-other-f369131625d4', 'papercusp')).toBe(false);
    expect(isCandidateWorktreeName('green-candidate-papercusp-', 'papercusp')).toBe(false);
    expect(isCandidateWorktreeName('.papercusp', 'papercusp')).toBe(false);
  });
});

function deps(overrides: Partial<CandidateWorktreeReapDeps> = {}): CandidateWorktreeReapDeps {
  return {
    gitWorktreeRemove: vi.fn(async () => ({ ok: true })),
    removeDirectory: vi.fn(async () => {}),
    gitWorktreePrune: vi.fn(async () => {}),
    log: vi.fn(),
    hasGitDir: () => true,
    ...overrides,
  };
}

describe('executeCandidateWorktreeReap', () => {
  it('removes a registered worktree through git and then prunes admin entries', async () => {
    const d = deps();
    const result = await executeCandidateWorktreeReap(
      plan([entry('green-candidate-papercusp-2d3106addae0')]),
      d,
    );
    expect(d.gitWorktreeRemove).toHaveBeenCalledTimes(1);
    expect(d.removeDirectory).not.toHaveBeenCalled();
    expect(d.gitWorktreePrune).toHaveBeenCalledTimes(1);
    expect(result.removed).toHaveLength(1);
    expect(result.prunedAdmin).toBe(true);
    expect(result.failed).toEqual([]);
  });

  it('removes an ADMIN-ORPHANED tree by directory, never asking git', async () => {
    // 7 of the 13 leaked trees had no `.git` at all; `git worktree remove` cannot see them.
    const d = deps({ hasGitDir: () => false });
    const result = await executeCandidateWorktreeReap(
      plan([entry('green-candidate-papercusp-228840fcdc13')]),
      d,
    );
    expect(d.gitWorktreeRemove).not.toHaveBeenCalled();
    expect(d.removeDirectory).toHaveBeenCalledTimes(1);
    expect(result.removed).toHaveLength(1);
  });

  it('falls back to directory removal when git refuses', async () => {
    const d = deps({
      gitWorktreeRemove: vi.fn(async () => ({ ok: false, detail: 'is dirty' })),
    });
    const result = await executeCandidateWorktreeReap(
      plan([entry('green-candidate-papercusp-2d3106addae0')]),
      d,
    );
    expect(d.removeDirectory).toHaveBeenCalledTimes(1);
    expect(result.removed).toHaveLength(1);
  });

  it('reports a reclaim failure instead of throwing — it must not wedge the gate', async () => {
    const d = deps({
      gitWorktreeRemove: vi.fn(async () => ({ ok: false })),
      removeDirectory: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const result = await executeCandidateWorktreeReap(
      plan([entry('green-candidate-papercusp-2d3106addae0')]),
      d,
    );
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([
      { path: path.join(ROOT, 'green-candidate-papercusp-2d3106addae0'), detail: 'EACCES' },
    ]);
  });

  it('survives a failing prune and still reports what it removed', async () => {
    const d = deps({
      gitWorktreePrune: vi.fn(async () => {
        throw new Error('prune exploded');
      }),
    });
    const result = await executeCandidateWorktreeReap(
      plan([entry('green-candidate-papercusp-2d3106addae0')]),
      d,
    );
    expect(result.removed).toHaveLength(1);
    expect(result.prunedAdmin).toBe(false);
  });

  it('does not prune when nothing was removed', async () => {
    const live = entry('green-candidate-papercusp-f369131625d4');
    const d = deps();
    const result = await executeCandidateWorktreeReap(
      plan([live], { activeWorktreePaths: [live.path] }),
      d,
    );
    expect(d.gitWorktreeRemove).not.toHaveBeenCalled();
    expect(d.removeDirectory).not.toHaveBeenCalled();
    expect(d.gitWorktreePrune).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.preserved).toEqual([{ path: live.path, reason: 'active-candidate' }]);
  });
});
