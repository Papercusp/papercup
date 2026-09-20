/**
 * disarm-schedule.test.ts — the plans:disarm-schedule HANDLER (disarmPlanSchedule
 * mocked). Pins the not_found guard and the delegation: it resolves the plan's
 * (workspace, harness, slug) and disarms with those, keeping the authored schedule (so
 * re-arm is one call). A regression that disarms an unknown plan or mis-scopes the
 * disarm is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/disarm-schedule.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn() }));
vi.mock('../../harness/routines/arm-plan-schedule', () => ({ disarmPlanSchedule: vi.fn() }));

import { getPlanRow } from './source';
import { disarmPlanSchedule } from '../../harness/routines/arm-plan-schedule';
const getRow = vi.mocked(getPlanRow);
const disarmM = vi.mocked(disarmPlanSchedule);
const tool = (await import('./disarm-schedule')).default;

type Out = { data?: any; content?: { text: string }[]; isError?: boolean };
const call = (slug = 'p1') => tool.handler({ harness: 'web', slug } as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  disarmM.mockResolvedValue(undefined as never);
});

describe('plans:disarm-schedule handler', () => {
  it('not_found for an unknown plan, and does not disarm', async () => {
    getRow.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 }, results: [{ ok: false, error: 'not_found', slug: 'p1' }] });
    expect(disarmM).not.toHaveBeenCalled();
  });

  it('disarms with the resolved scope and returns ok', async () => {
    getRow.mockResolvedValue({ workspaceId: 'default', harnessSlug: 'web' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, slug: 'p1' }] });
    expect(disarmM).toHaveBeenCalledWith({ workspaceId: 'default', harnessSlug: 'web', templateSlug: 'p1' });
  });

  it('disarms selected slugs as a keyed batch', async () => {
    getRow.mockResolvedValue({ workspaceId: 'default', harnessSlug: 'web' } as never);
    const out = (await tool.handler({ harness: 'web', slugs: ['p1', 'p2'] } as never, {} as never)) as Out;
    const b = body(out);
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => r.slug)).toEqual(['p1', 'p2']);
    expect(disarmM).toHaveBeenCalledTimes(2);
  });
});
