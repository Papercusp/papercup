/**
 * get-item.test.ts — the plans:get-item HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Pins: the inline { slug, itemId }
 * single form → one result; itemIds:[…] (one plan) + items:[…] (cross-plan) fan-out;
 * a missing item / missing plan → that item's { ok:false } WITHOUT failing the batch;
 * and that the per-slug row fetch is memoized across the batch.
 *
 * The plan-source layer is mocked so this runs as a pure unit test (no PG).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/get-item.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({})) }));
// Keep the real `harnessArg` zod schema; only stub `harnessScopedCtx` so the test
// ctx (which carries no harnessSlug) does not trip the harness-required gate.
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn(), planItemsForRow: (row: { items: unknown[] }) => row.items }));
vi.mock('./effective-status', () => ({
  // pass the items through unchanged (effectiveStatus resolution is tested elsewhere)
  resolveEffectiveStatusForItems: (items: unknown[]) => ({ items }),
}));
vi.mock('../../issue-blocks-merge', () => ({
  getAllBlockedPlanItems: vi.fn(async () => new Map()),
  applyPlanItemBlocks: (items: unknown[]) => ({ items, blockingIssues: {} }),
  planItemRef: (slug: string, id: string) => `${slug}#${id}`,
}));

import { getPlanRow } from './source';
const getRowM = vi.mocked(getPlanRow);
const tool = (await import('./get-item')).default;

type Out = { content: { text: string }[] };
const body = async (args: Record<string, unknown>) =>
  JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

// A minimal PlanRow stub carrying the items the handler reads.
const rowOf = (slug: string, ids: string[]) =>
  ({
    planSlug: slug,
    isLegacy: false,
    archived: false,
    items: ids.map((id) => ({ id, storedStatus: 'todo', effectiveStatus: 'todo' })),
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe('plans:get-item handler (bulk keyed-array)', () => {
  it('inline { slug, itemId } returns a single result', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001']));
    const b = await body({ slug: 'plan-a', itemId: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'plan-a', itemId: 'P-001', item: { id: 'P-001' } });
  });

  it('itemIds:[…] reads many of one plan; a missing item fails only itself', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001', 'P-002']));
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-099', 'P-002'] });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.results).toHaveLength(3);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { itemId: string; ok: boolean }) => [r.itemId, r.ok])).toEqual([
      ['P-001', true],
      ['P-099', false],
      ['P-002', true],
    ]);
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-099', error: 'item_not_found' });
    // the per-slug row is fetched ONCE for all three items
    expect(getRowM).toHaveBeenCalledTimes(1);
  });

  it('a missing plan maps to not_found per item (batch survives)', async () => {
    getRowM.mockImplementation(async (slug: string) => (slug === 'gone' ? null : rowOf(slug, ['P-001'])));
    const b = await body({ items: [{ slug: 'plan-a', itemId: 'P-001' }, { slug: 'gone', itemId: 'P-001' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'gone', itemId: 'P-001', error: 'not_found' });
  });

  it('items:[…] cross-plan keeps each result keyed by { slug, itemId }', async () => {
    getRowM.mockImplementation(async (slug: string) => rowOf(slug, ['P-001']));
    const b = await body({ items: [{ slug: 'plan-a', itemId: 'P-001' }, { slug: 'plan-b', itemId: 'P-001' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { slug: string }) => r.slug)).toEqual(['plan-a', 'plan-b']);
    expect(getRowM).toHaveBeenCalledTimes(2); // distinct slugs → distinct fetches
  });

  it('a legacy plan maps to legacy_plan per item', async () => {
    getRowM.mockResolvedValue({ planSlug: 'plan-a', isLegacy: true } as never);
    const b = await body({ slug: 'plan-a', itemId: 'P-001' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'legacy_plan' });
  });
});
