import { describe, it, expect, vi } from 'vitest';
import { makeSweProCloneGradeSeam, SWE_PRO_TOPOLOGY_ARMS } from './swe-pro-seam';
import type { BenchTask, TaskCheckout } from './types';

function task(id = 't1'): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: id,
    problemStatement: 'fix the bug',
    repo: 'org/repo',
    baseCommit: 'a'.repeat(40),
    graderMeta: {},
  } as BenchTask;
}

function fakeCheckout(cleanup: () => Promise<void>): TaskCheckout {
  return { dir: '/tmp/wt', repo: 'org/repo', baseCommit: 'a'.repeat(40), cleanup };
}

describe('makeSweProCloneGradeSeam', () => {
  it('is a diff-modality seam that clones via the injected clone', async () => {
    const checkout = fakeCheckout(async () => {});
    const seam = makeSweProCloneGradeSeam({
      cloneTaskRepo: async () => checkout,
      extractDiff: async () => 'diff',
      gradeDiff: async () => true,
    });
    expect(seam.modality).toBe('diff');
    expect(await seam.clone(task())).toBe(checkout);
  });

  it('grades a non-empty diff via the injected grader → passed/failed', async () => {
    const seamPass = makeSweProCloneGradeSeam({ extractDiff: async () => 'real diff', gradeDiff: async () => true });
    expect(await seamPass.grade(task(), fakeCheckout(async () => {}))).toEqual({ resolved: true, graderStatus: 'passed' });
    const seamFail = makeSweProCloneGradeSeam({ extractDiff: async () => 'real diff', gradeDiff: async () => false });
    expect(await seamFail.grade(task(), fakeCheckout(async () => {}))).toEqual({ resolved: false, graderStatus: 'failed' });
  });

  it('an EMPTY diff is a capability-fail (resolved false, empty-diff) — no grader run', async () => {
    const gradeDiff = vi.fn(async () => true);
    const seam = makeSweProCloneGradeSeam({ extractDiff: async () => '   \n  ', gradeDiff });
    expect(await seam.grade(task(), fakeCheckout(async () => {}))).toEqual({ resolved: false, graderStatus: 'empty-diff' });
    expect(gradeDiff).not.toHaveBeenCalled(); // an empty diff can't pass — never wastes a grader run
  });

  it('an extract crash → resolved null + error (infra, reconciled false in the C1 headline)', async () => {
    const seam = makeSweProCloneGradeSeam({
      extractDiff: async () => {
        throw new Error('git diff failed');
      },
      gradeDiff: async () => true,
    });
    const r = await seam.grade(task(), fakeCheckout(async () => {}));
    expect(r.resolved).toBeNull();
    expect(r.graderStatus).toBe('error');
    expect(r.detail).toMatchObject({ stage: 'extract' });
  });

  it('a grader crash → resolved null + error (never a false — do not penalize the arm for docker infra)', async () => {
    const seam = makeSweProCloneGradeSeam({
      extractDiff: async () => 'real diff',
      gradeDiff: async () => {
        throw new Error('docker eval crashed');
      },
    });
    const r = await seam.grade(task(), fakeCheckout(async () => {}));
    expect(r.resolved).toBeNull();
    expect(r.graderStatus).toBe('error');
    expect(r.detail).toMatchObject({ stage: 'grade' });
  });

  it('teardown is never-throw and always cleans the worktree', async () => {
    const cleanup = vi.fn(async () => {});
    const seam = makeSweProCloneGradeSeam({ gradeDiff: async () => true });
    await seam.teardown(fakeCheckout(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
    // a throwing cleanup must not escape teardown
    const seam2 = makeSweProCloneGradeSeam({ gradeDiff: async () => true });
    await expect(seam2.teardown(fakeCheckout(async () => { throw new Error('rm failed'); }))).resolves.toBeUndefined();
  });

  it('maps the plan framework arms → the steward topology blueprint ids', () => {
    expect(SWE_PRO_TOPOLOGY_ARMS).toEqual({ vanilla: 'su-independent', su: 'dist-broadcast', hive: 'hive' });
  });
});
