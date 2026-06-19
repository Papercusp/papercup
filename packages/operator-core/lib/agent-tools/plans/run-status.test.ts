/**
 * run-status.test.ts — the plans:set-run-status HANDLER (the run-store fns in ./runs
 * are covered by __tests__/runs.test.ts; this pins the handler's own control flow).
 *
 * Load-bearing behaviors:
 *  - not_found when the run id is unknown;
 *  - the run_busy GUARD — a `running` run is rejected so a manual restatus can't race
 *    the turn's own settle (the real canManuallyRestatusRun predicate is exercised);
 *  - on success it writes the new status, echoes previousStatus, and emits a
 *    from→to metadata breadcrumb.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/run-status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runs', async (orig) => ({
  ...(await orig<typeof import('./runs')>()),
  getPlanRun: vi.fn(),
  setPlanRunStatus: vi.fn(),
}));

import { getPlanRun, setPlanRunStatus } from './runs';
const getRun = vi.mocked(getPlanRun);
const setStatus = vi.mocked(setPlanRunStatus);
const tool = (await import('./run-status')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (runId: number, status: string) =>
  tool.handler({ runId, status } as never, { metadata: meta } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  getRun.mockReset();
  setStatus.mockReset().mockResolvedValue(undefined as never);
  meta.mockReset();
});

describe('plans:set-run-status handler', () => {
  it('returns not_found for an unknown run and does not write', async () => {
    getRun.mockResolvedValue(null as never);
    const out = await call(7, 'archived');
    expect(out.isError).toBe(true);
    expect(body(out).error).toBe('not_found');
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects a running run (run_busy) — guards against racing the turn settle', async () => {
    getRun.mockResolvedValue({ status: 'running' } as never);
    const out = await call(7, 'done');
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'run_busy', status: 'running' });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('archives a settled run, echoes previousStatus, and emits a from→to breadcrumb', async () => {
    getRun.mockResolvedValue({ status: 'idle' } as never);
    const out = await call(7, 'archived');
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ runId: 7, status: 'archived', previousStatus: 'idle' });
    expect(setStatus).toHaveBeenCalledWith(7, 'archived');
    expect(meta).toHaveBeenCalledWith({ runId: 7, from: 'idle', to: 'archived' });
  });

  it('un-archives (done → idle) — a settled run can be reopened', async () => {
    getRun.mockResolvedValue({ status: 'done' } as never);
    const out = await call(7, 'idle');
    expect(body(out)).toMatchObject({ status: 'idle', previousStatus: 'done' });
    expect(setStatus).toHaveBeenCalledWith(7, 'idle');
  });
});
