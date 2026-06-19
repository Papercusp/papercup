/**
 * run-now.test.ts — the plans:run-now HANDLER control flow (getPlanRow +
 * runScheduledPlanFire are mocked; getOrgPg returns a throwaway sql the handler only
 * passes through). Pins: not_found when the plan is unknown, the trigger:'manual'
 * delegation with the plan's install/workspace, the success projection, and the
 * run_failed mapping (a falsy fire result becomes an isError {error:'run_failed'}). A
 * regression that drops a guard or mislabels the trigger is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/run-now.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn() }));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('../../harness/routines/plan-run-action', () => ({ runScheduledPlanFire: vi.fn() }));

import { getPlanRow } from './source';
import { runScheduledPlanFire } from '../../harness/routines/plan-run-action';
const getRow = vi.mocked(getPlanRow);
const fire = vi.mocked(runScheduledPlanFire);
const tool = (await import('./run-now')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const call = (slug = 'p1') => tool.handler({ harness: 'web', slug } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  getRow.mockReset();
  fire.mockReset();
});

describe('plans:run-now handler', () => {
  it('returns not_found for an unknown plan and does not fire', async () => {
    getRow.mockResolvedValue(null as never);
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'not_found', slug: 'p1' });
    expect(fire).not.toHaveBeenCalled();
  });

  it('fires a manual run with the plan install/workspace and returns the run', async () => {
    getRow.mockResolvedValue({ harnessSlug: 'web', workspaceId: 'default' } as never);
    fire.mockResolvedValue({ runId: 5, instanceSlug: 'p1-run-5' } as never);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true, runId: 5, instanceSlug: 'p1-run-5' });
    expect(fire.mock.calls[0]![1]).toMatchObject({
      installSlug: 'web', workspaceId: 'default', templateSlug: 'p1', trigger: 'manual',
    });
  });

  it('maps a falsy fire result to run_failed (isError)', async () => {
    getRow.mockResolvedValue({ harnessSlug: 'web', workspaceId: 'default' } as never);
    fire.mockResolvedValue(null as never);
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'run_failed', slug: 'p1' });
  });
});
