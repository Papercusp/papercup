/**
 * runs-list.test.ts — the plans:runs HANDLER (listPlanRuns/sweepPlanRuns mocked). Pins
 * the handler's own discipline: it runs the best-effort lifecycle sweep first, returns
 * the runs (empty list is NOT an error), emits a runCount breadcrumb, and — the
 * load-bearing bit — maps a genuine DB failure to an explicit isError
 * {error:'runs_unavailable'} rather than a misleading empty list. console is suppressed
 * (operator-core is fail-on-console; the sweep warns on its own failure path).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/runs-list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'web') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./runs', () => ({ listPlanRuns: vi.fn(), sweepPlanRuns: vi.fn() }));

import { listPlanRuns, sweepPlanRuns } from './runs';
const listM = vi.mocked(listPlanRuns);
const sweepM = vi.mocked(sweepPlanRuns);
const tool = (await import('./runs-list')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (slug = 'p1') => tool.handler({ slug, harness: 'web' } as never, { metadata: meta } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sweepM.mockResolvedValue(undefined as never);
});

describe('plans:runs handler', () => {
  it('sweeps, returns the runs, and emits a runCount breadcrumb', async () => {
    listM.mockResolvedValue([{ id: 1, title: 'r1', status: 'done' }] as never);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ runs: [{ id: 1, title: 'r1' }] });
    expect(sweepM).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith({ slug: 'p1', runCount: 1 });
  });

  it('returns an empty list (not an error) when the plan has no runs', async () => {
    listM.mockResolvedValue([] as never);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ runs: [] });
  });

  it('maps a DB failure to runs_unavailable (isError) — never a misleading empty list', async () => {
    listM.mockRejectedValue(new Error('pg down'));
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'runs_unavailable', slug: 'p1' });
    expect(String(body(out).message)).toMatch(/pg down/);
  });
});
