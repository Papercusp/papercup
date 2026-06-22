/**
 * reproject.test.ts — the rationale:reproject HANDLER dispatch + per-kind arg
 * validation (the reproject* ops in ../../rationale/service are the PG layer, mocked
 * here). This pins the handler's own logic: it routes each `kind` to the right service
 * op, REQUIRES the kind-specific args (id for plan/work_item; objectKind+objectRef for
 * tagged) and errors without writing when they're missing, and shapes the summary
 * (insight count, all-backfill spread). A regression that routes a kind to the wrong op
 * or drops a required-arg check is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rationale/reproject.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../rationale/service', () => ({
  reprojectPlan: vi.fn(),
  reprojectWorkItem: vi.fn(),
  reprojectTagged: vi.fn(),
  reprojectInsights: vi.fn(),
  backfillAll: vi.fn(),
}));

import {
  reprojectPlan, reprojectWorkItem, reprojectTagged, reprojectInsights, backfillAll,
} from '../../rationale/service';
const plan = vi.mocked(reprojectPlan);
const wi = vi.mocked(reprojectWorkItem);
const tagged = vi.mocked(reprojectTagged);
const insights = vi.mocked(reprojectInsights);
const all = vi.mocked(backfillAll);
const tool = (await import('./reproject')).default;

type Out = { data?: any; content?: { text: string }[]; isError?: boolean };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('rationale:reproject dispatch', () => {
  it('plan: requires id — errors and does not reproject when missing', async () => {
    const b = body(await call({ kind: 'plan' }));
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(String(b.results[0].error)).toMatch(/id .*required/i);
    expect(plan).not.toHaveBeenCalled();
  });

  it('plan: routes to reprojectPlan(id, harness) and reports it', async () => {
    const b = body(await call({ kind: 'plan', id: 'my-plan', harness: 'web' }));
    expect(plan).toHaveBeenCalledWith('my-plan', 'web');
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, reprojected: 'plan', id: 'my-plan' }] });
  });

  it('work_item: requires id', async () => {
    const out = body(await call({ kind: 'work_item' }));
    expect(out.counts.failed).toBe(1);
    expect(wi).not.toHaveBeenCalled();
  });

  it('work_item: routes to reprojectWorkItem', async () => {
    const b = body(await call({ kind: 'work_item', id: 'WI-9' }));
    expect(wi).toHaveBeenCalledWith('WI-9', undefined);
    expect(b.results[0]).toMatchObject({ ok: true, reprojected: 'work_item', id: 'WI-9' });
  });

  it('tagged: requires both objectKind and objectRef', async () => {
    expect(body(await call({ kind: 'tagged', objectKind: 'doc' })).counts.failed).toBe(1);
    expect(body(await call({ kind: 'tagged', objectRef: 'x' })).counts.failed).toBe(1);
    expect(tagged).not.toHaveBeenCalled();
  });

  it('tagged: routes to reprojectTagged(objectKind, objectRef)', async () => {
    const b = body(await call({ kind: 'tagged', objectKind: 'doc', objectRef: 'slug-1' }));
    expect(tagged).toHaveBeenCalledWith('doc', 'slug-1');
    expect(b.results[0]).toMatchObject({ ok: true, reprojected: 'tagged', objectKind: 'doc', objectRef: 'slug-1' });
  });

  it('insight: reprojects all insights and reports the count', async () => {
    insights.mockResolvedValue(5 as never);
    const b = body(await call({ kind: 'insight' }));
    expect(insights).toHaveBeenCalledTimes(1);
    expect(b.results[0]).toMatchObject({ ok: true, reprojected: 'insight', count: 5 });
  });

  it('all: backfills and spreads the summary', async () => {
    all.mockResolvedValue({ plans: 3, workItems: 4 } as never);
    const b = body(await call({ kind: 'all' }));
    expect(all).toHaveBeenCalledTimes(1);
    expect(b.results[0]).toMatchObject({ ok: true, reprojected: 'all', plans: 3, workItems: 4 });
  });

  it('items:[…] reprojects many and isolates a bad item', async () => {
    const b = body(await call({
      items: [
        { kind: 'plan', id: 'my-plan', harness: 'web' },
        { kind: 'work_item' },
        { kind: 'tagged', objectKind: 'doc', objectRef: 'slug-1' },
      ],
    }));
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => r.ok)).toEqual([true, false, true]);
    expect(plan).toHaveBeenCalledWith('my-plan', 'web');
    expect(tagged).toHaveBeenCalledWith('doc', 'slug-1');
  });
});
