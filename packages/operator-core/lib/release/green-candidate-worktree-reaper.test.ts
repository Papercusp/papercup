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
  CANDIDATE_WORKTREE_PRESSURE_MIN_AGE_MS,
  DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS,
  candidateWorktreeSweepLogLines,
  effectiveCandidateWorktreeMinAgeMs,
  executeCandidateWorktreeReap,
  isCandidateWorktreeName,
  planCandidateWorktreeReap,
  summarizeCandidateWorktreePreservations,
  type CandidateWorktreeEntry,
  type CandidateWorktreeReapDeps,
  type CandidateWorktreeReapResult,
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

  // EI-21714994180505750: the plan is a SNAPSHOT. A gate worktree went dirtyTracked 0 -> 14
  // in four minutes when a repair agent began editing inside it, and the age floor cannot
  // see that (editing files deep in a tree never touches the top-level directory mtime).
  describe('at-delete re-check', () => {
    it('spares a tree a peer entered between the scan and the delete', async () => {
      const d = deps({ confirmStillAbandoned: vi.fn(async () => false) });
      const target = entry('green-candidate-papercusp-228840fcdc13');
      const result = await executeCandidateWorktreeReap(plan([target]), d);

      expect(d.gitWorktreeRemove).not.toHaveBeenCalled();
      expect(d.removeDirectory).not.toHaveBeenCalled();
      expect(result.removed).toEqual([]);
      expect(result.preserved).toContainEqual({
        path: target.path,
        reason: 'became-active-since-scan',
      });
    });

    it('CONTROL: the identical entry IS removed when the re-check says abandoned', async () => {
      // Without this, the test above would pass against a reaper that never deletes anything.
      const d = deps({ confirmStillAbandoned: vi.fn(async () => true) });
      const result = await executeCandidateWorktreeReap(
        plan([entry('green-candidate-papercusp-228840fcdc13')]),
        d,
      );
      expect(result.removed).toHaveLength(1);
      expect(result.preserved).toEqual([]);
    });

    it('re-checks EVERY entry, not just the first', async () => {
      const confirmStillAbandoned = vi.fn(async (p: string) => !p.endsWith('bbbbbbbbbbbb'));
      const d = deps({ confirmStillAbandoned });
      const result = await executeCandidateWorktreeReap(
        plan([
          entry('green-candidate-papercusp-aaaaaaaaaaaa'),
          entry('green-candidate-papercusp-bbbbbbbbbbbb'),
          entry('green-candidate-papercusp-cccccccccccc'),
        ]),
        d,
      );
      expect(confirmStillAbandoned).toHaveBeenCalledTimes(3);
      expect(result.removed).toHaveLength(2);
      expect(result.preserved).toEqual([
        {
          path: path.join(ROOT, 'green-candidate-papercusp-bbbbbbbbbbbb'),
          reason: 'became-active-since-scan',
        },
      ]);
    });

    it('still reaps when no re-check seam is supplied', async () => {
      const d = deps();
      delete (d as { confirmStillAbandoned?: unknown }).confirmStillAbandoned;
      const result = await executeCandidateWorktreeReap(
        plan([entry('green-candidate-papercusp-aaaaaaaaaaaa')]),
        d,
      );
      expect(result.removed).toHaveLength(1);
    });
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

/**
 * WI-954677 / EI-21844531592346894 — the sweep must ACCOUNT FOR ITSELF on every pass.
 *
 * The regression these guard against is not a crash, it is SILENCE: the sweep used to log
 * only when it removed something, so a pass that refused every tree was indistinguishable
 * from a pass that never ran. That indistinguishability let candidate worktrees fill the
 * host to 94% unnoticed, and led a correct reading of the module to conclude it had no
 * production caller at all.
 *
 * Note what the pre-existing tests could not catch: they assert the PLAN and the REMOVALS,
 * both of which were always correct. The defect lived entirely in what was reported.
 */
function preservedAs(
  reason: CandidateWorktreeReapResult['preserved'][number]['reason'],
  name = 'green-candidate-papercusp-aaaaaaaaaaaa',
) {
  return { path: path.join(ROOT, name), reason };
}

/**
 * WI-954677 — the pressure-aware age floor (gate-owner ruling: an OVERRIDE, never a lower
 * static floor).
 *
 * The property that matters is narrow and easy to get wrong: pressure may shorten the AGE
 * floor and nothing else. It must not widen which trees are eligible in kind, and it must
 * not be able to lengthen the floor either.
 */
describe('effectiveCandidateWorktreeMinAgeMs', () => {
  it('CALIBRATION: no pressure means the ordinary 6h floor', () => {
    expect(effectiveCandidateWorktreeMinAgeMs({})).toBe(DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS);
    expect(effectiveCandidateWorktreeMinAgeMs({ diskPressure: false })).toBe(
      DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS,
    );
  });

  it('shortens the floor under pressure', () => {
    expect(effectiveCandidateWorktreeMinAgeMs({ diskPressure: true })).toBe(
      CANDIDATE_WORKTREE_PRESSURE_MIN_AGE_MS,
    );
    expect(CANDIDATE_WORKTREE_PRESSURE_MIN_AGE_MS).toBeLessThan(
      DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS,
    );
  });

  it('NEVER lengthens the floor — pressure that would raise it is clamped', () => {
    // Asking pressure to make the reaper MORE conservative inverts the override's purpose.
    expect(
      effectiveCandidateWorktreeMinAgeMs({
        diskPressure: true,
        minAgeMs: 60_000,
        pressureMinAgeMs: 9_999_999,
      }),
    ).toBe(60_000);
  });
});

describe('planCandidateWorktreeReap under disk pressure', () => {
  const THIRTY_MIN = NOW - 30 * 60_000;

  it('CONTROL: a 30-minute-old tree is preserved with no pressure', () => {
    const p = plan([entry('green-candidate-papercusp-f369131625d4', THIRTY_MIN)]);
    expect(p.reap).toEqual([]);
    expect(p.preserved[0]?.reason).toBe('too-young');
    expect(p.diskPressure).toBe(false);
    expect(p.minAgeMsApplied).toBe(DEFAULT_CANDIDATE_WORKTREE_MIN_AGE_MS);
  });

  it('reaps that SAME tree once the caller reports pressure', () => {
    const p = plan([entry('green-candidate-papercusp-f369131625d4', THIRTY_MIN)], {
      diskPressure: true,
    });
    expect(p.reap).toHaveLength(1);
    expect(p.diskPressure).toBe(true);
    expect(p.minAgeMsApplied).toBe(CANDIDATE_WORKTREE_PRESSURE_MIN_AGE_MS);
  });

  it('still refuses a tree younger than the pressure floor — pressure is not "reap everything"', () => {
    const p = plan([entry('green-candidate-papercusp-f369131625d4', NOW - 60_000)], {
      diskPressure: true,
    });
    expect(p.reap).toEqual([]);
    expect(p.preserved[0]?.reason).toBe('too-young');
  });

  it('SAFETY: pressure does NOT override the active-candidate guard', () => {
    // The whole point of the override is that it spends the AGE margin only. If pressure
    // could reach a live candidate it would destroy the running gate's own worktree — the
    // single worst outcome available to this module.
    const live = entry('green-candidate-papercusp-f369131625d4', THIRTY_MIN);
    const p = plan([live], { diskPressure: true, activeWorktreePaths: [live.path] });
    expect(p.reap).toEqual([]);
    expect(p.preserved).toEqual([{ entry: live, reason: 'active-candidate' }]);
  });

  it('SAFETY: pressure does NOT override the namespace guard', () => {
    const foreign = entry('some-operators-scratch-dir', THIRTY_MIN);
    const p = plan([foreign], { diskPressure: true });
    expect(p.reap).toEqual([]);
    expect(p.preserved).toEqual([{ entry: foreign, reason: 'unrecognized-name' }]);
  });
});

describe('summarizeCandidateWorktreePreservations', () => {
  it('counts each reason', () => {
    expect(
      summarizeCandidateWorktreePreservations([
        preservedAs('too-young'),
        preservedAs('too-young'),
        preservedAs('active-candidate'),
      ]),
    ).toBe('too-young=2 active-candidate=1');
  });

  it('orders by descending count, then reason name, so consecutive runs diff cleanly', () => {
    expect(
      summarizeCandidateWorktreePreservations([
        preservedAs('unrecognized-name'),
        preservedAs('active-candidate'),
      ]),
    ).toBe('active-candidate=1 unrecognized-name=1');
  });

  it('is empty for no preservations', () => {
    expect(summarizeCandidateWorktreePreservations([])).toBe('');
  });
});

describe('candidateWorktreeSweepLogLines', () => {
  it('REGRESSION: reports a sweep that reaped NOTHING but refused trees', () => {
    // The exact shape that was silent before: trees present, all under the age floor.
    const young = entry('green-candidate-papercusp-f369131625d4', NOW - 60_000);
    const lines = candidateWorktreeSweepLogLines(plan([young]), null);

    expect(lines).toEqual([
      'candidate-worktree sweep: reaped 0, preserved 1 (too-young=1) [floor=6h]',
    ]);
  });

  it('CONTROL: never returns zero lines, whatever the sweep did', () => {
    // A silent pass is the defect itself, so "emitted nothing" must be unreachable.
    const young = entry('green-candidate-papercusp-f369131625d4', NOW - 60_000);
    const cases: Array<[ReturnType<typeof plan>, CandidateWorktreeReapResult | null]> = [
      [plan([]), null],
      [plan([young]), null],
      [
        plan([entry('green-candidate-papercusp-aaaaaaaaaaaa')]),
        { removed: [path.join(ROOT, 'green-candidate-papercusp-aaaaaaaaaaaa')], failed: [], preserved: [], prunedAdmin: true },
      ],
    ];
    for (const [p, r] of cases) {
      expect(candidateWorktreeSweepLogLines(p, r).length).toBeGreaterThan(0);
    }
  });

  it('says so plainly when there are no candidate worktrees at all', () => {
    expect(candidateWorktreeSweepLogLines(plan([]), null)).toEqual([
      'candidate-worktree sweep: no candidate worktrees present',
    ]);
  });

  it('names what it reclaimed', () => {
    const doomed = entry('green-candidate-papercusp-aaaaaaaaaaaa');
    const lines = candidateWorktreeSweepLogLines(plan([doomed]), {
      removed: [doomed.path],
      failed: [],
      preserved: [],
      prunedAdmin: true,
    });
    expect(lines).toEqual([
      'candidate-worktree sweep: reaped 1, preserved 0 [floor=6h]: green-candidate-papercusp-aaaaaaaaaaaa',
    ]);
  });

  it('surfaces a reclaim FAILURE that was previously computed and discarded', () => {
    // Pinned as a FULL array, not a `toContain`: a failing reclaim leaves `removed` and
    // `preserved` both empty, and an emptiness test that ignores `failed` therefore reports
    // "no candidate worktrees present" while the reclaim is broken. That regression was
    // written, and this assertion is what caught it — `toContain` alone would not have.
    const doomed = entry('green-candidate-papercusp-aaaaaaaaaaaa');
    const lines = candidateWorktreeSweepLogLines(plan([doomed]), {
      removed: [],
      failed: [{ path: doomed.path, detail: 'device or resource busy' }],
      preserved: [],
      prunedAdmin: false,
    });
    expect(lines).toEqual([
      'candidate-worktree sweep: reaped 0, preserved 0, failed 1 [floor=6h]',
      'warn: candidate-worktree sweep could not reclaim green-candidate-papercusp-aaaaaaaaaaaa: device or resource busy',
    ]);
  });

  it('reports the PRESSURE floor, so a shortened sweep is never mistaken for the default', () => {
    const young = entry('green-candidate-papercusp-f369131625d4', NOW - 5 * 60_000);
    const lines = candidateWorktreeSweepLogLines(plan([young], { diskPressure: true }), null);
    expect(lines).toEqual([
      'candidate-worktree sweep: reaped 0, preserved 1 (too-young=1) [floor=20m under disk pressure]',
    ]);
  });

  it('prefers the executed result, so an at-delete re-check refusal is not lost', () => {
    // `became-active-since-scan` exists ONLY on the result — a plan cannot know it.
    const doomed = entry('green-candidate-papercusp-aaaaaaaaaaaa');
    const lines = candidateWorktreeSweepLogLines(plan([doomed]), {
      removed: [],
      failed: [],
      preserved: [{ path: doomed.path, reason: 'became-active-since-scan' }],
      prunedAdmin: false,
    });
    expect(lines[0]).toBe(
      'candidate-worktree sweep: reaped 0, preserved 1 (became-active-since-scan=1) [floor=6h]',
    );
  });
});
