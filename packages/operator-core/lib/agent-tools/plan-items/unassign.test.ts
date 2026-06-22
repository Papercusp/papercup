/**
 * unassign.test.ts — the plan_items:unassign HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21 P-004). resolvePlanScope/unassignItem
 * mocked. Pins the scope resolution + the per-item result branch: a real release is
 * { ok:true, plan, item, released }, while no active assignment is { ok:true, plan,
 * item, released:null, note } rather than an error (soft-release is idempotent), and
 * MANY via itemIds:[…] fans out. A regression that errors on a no-op unassign, or
 * loses the keyed-array envelope, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/unassign.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plans/source', () => ({ resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn() }));

import { unassignItem } from '../../plan-items/assignments';
const unassignM = vi.mocked(unassignItem);
const tool = (await import('./unassign')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('plan_items:unassign handler (bulk keyed-array)', () => {
  it('returns the released assignment when one existed (single inline → n=1)', async () => {
    unassignM.mockResolvedValue({ assignee: 'bee-1' } as never);
    const b = await body({ plan: 'p1', item: 'P-001', harness: 'web' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, plan: 'p1', item: 'P-001', released: { assignee: 'bee-1' } });
    expect(unassignM).toHaveBeenCalledWith('default', 'web', 'p1', 'P-001');
  });

  it('is a no-op (released:null + note) when there was no active assignment', async () => {
    unassignM.mockResolvedValue(null as never);
    const b = await body({ plan: 'p1', item: 'P-001', harness: 'web' });
    expect(b.results[0]).toMatchObject({ ok: true, plan: 'p1', item: 'P-001', released: null, note: 'no active assignment' });
  });

  it('unassigns MANY in the same plan via itemIds:[…]', async () => {
    unassignM.mockImplementation(async (_ws, _h, _p, item: string) => ({ itemId: item }) as never);
    const b = await body({ plan: 'p1', itemIds: ['P-001', 'P-002'], harness: 'web' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { item: string }) => r.item)).toEqual(['P-001', 'P-002']);
    expect(unassignM).toHaveBeenNthCalledWith(2, 'default', 'web', 'p1', 'P-002');
  });
});
