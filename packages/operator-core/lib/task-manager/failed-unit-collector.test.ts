import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { collectStaleFailedTaskUnits } from './failed-unit-collector';
import type { TaskTerminalProvenance } from './types';

function terminal(scopeUnit: string): TaskTerminalProvenance {
  return {
    capturedAt: '2026-09-26T20:00:00.000Z',
    scopeUnit,
    cgroupPath: null,
    invocationId: `invocation-${scopeUnit}`,
    loadState: 'loaded',
    activeState: 'failed',
    serviceResult: 'exit-code',
    execMainCode: 1,
    execMainStatus: 3,
    memoryMaxBytes: null,
    peakMemoryBytes: 4096,
    peakMemorySource: 'systemd',
  };
}

describe('collectStaleFailedTaskUnits', () => {
  it('resets only candidates whose terminal evidence became durable', async () => {
    const a = terminal('pc-aaaa1111.service');
    const b = terminal('pc-bbbb2222.service');
    const c = terminal('pc-cccc3333.service');
    const scan = vi.fn(async () => ({
      terminals: [a, b, c],
      listed: 9,
      inspected: 3,
      truncated: true,
      nextCursor: 3,
    }));
    const persist = vi.fn(async (candidate: TaskTerminalProvenance) => ({
      durable: candidate !== b,
      outcome: candidate === b ? ('refused' as const) : ('closed-existing' as const),
      taskId: candidate.scopeUnit.slice(3, -'.service'.length),
    }));
    const reset = vi.fn(async (candidate: TaskTerminalProvenance) => candidate !== c);

    const out = await collectStaleFailedTaskUnits({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      scan,
      persist,
      reset,
    });

    expect(out).toEqual({
      listed: 9,
      inspected: 3,
      candidates: 3,
      evidenceDurable: 2,
      reset: 1,
      refused: 1,
      resetFailed: 1,
      errors: 0,
      truncated: true,
      nextCursor: 3,
    });
    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalledWith(b);
  });

  it('contains one persistence failure and continues with later candidates', async () => {
    const first = terminal('pc-first111.service');
    const second = terminal('pc-second22.service');
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ durable: true, outcome: 'created-and-closed', taskId: 'second22' });
    const reset = vi.fn(async () => true);

    const out = await collectStaleFailedTaskUnits({
      scan: async () => ({
        terminals: [first, second],
        listed: 2,
        inspected: 2,
        truncated: false,
        nextCursor: 0,
      }),
      persist,
      reset,
    });

    expect(out).toMatchObject({ evidenceDurable: 1, reset: 1, errors: 1 });
    expect(reset).toHaveBeenCalledWith(second);
  });

  it('is wired into the existing task-reconcile routine rather than a parallel scheduler', () => {
    const action = readFileSync(new URL('../harness/routines/task-reconcile-action.ts', import.meta.url), 'utf8');
    expect(action).toContain('import { collectStaleFailedTaskUnits');
    expect(action).toContain('FAILED_UNIT_SWEEP_INTERVAL_MS');
    expect(action).toContain('await collectStaleFailedTaskUnits({');
  });
});
