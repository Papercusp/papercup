/**
 * convert.test.ts — the plan_items:convert HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21 P-004). convertPlanItem + scope/identity
 * + the flag read mocked. Pins: inline single → n=1 with the flattened convert
 * payload under results[0]; itemIds:[…] fan-out; a per-item refused/conflict convert
 * fails ONLY that item while top-level ok stays true (partial failure); the emits
 * `dataOf` helper digs results[0] out of the envelope so the pickup-broadcast +
 * todo→wip rules still see the flat shape.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/convert.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'sess-A', ownerLabel: 'A' }),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
    workspaceId: 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'user-A',
  resolveAdoptedName: vi.fn(async () => 'builder-1'),
}));
vi.mock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false),
}));

import { convertPlanItem } from '../../plan-items/convert';
const convM = vi.mocked(convertPlanItem);
const tool = (await import('./convert')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

const converted = (item: string, wiId: string) =>
  ({
    status: 'converted',
    workItem: { id: wiId, kind: 'task', harness: 'papercup' },
    claim: { owner: 'sess-A' },
    mode: 'availability',
    viaAssignment: false,
    planItem: { plan: 'p1', item, status: 'todo', text: 'x' },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  convM.mockImplementation(async (opts) => converted(opts.itemId, 'WI-1'));
});

describe('plan_items:convert handler (bulk keyed-array)', () => {
  it('converts one inline (n=1) and flattens the convert payload onto results[0]', async () => {
    const b = await body({ plan: 'p1', item: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      plan: 'p1',
      item: 'P-001',
      status: 'converted',
      workItem: { id: 'WI-1', kind: 'task' },
    });
    expect(convM).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'p1', itemId: 'P-001', owner: 'sess-A' }));
  });

  it('converts MANY in the same plan via itemIds:[…]', async () => {
    convM.mockImplementation(async (opts) => converted(opts.itemId, `WI-${opts.itemId}`));
    const b = await body({ plan: 'p1', itemIds: ['P-001', 'P-002'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { item: string }) => r.item)).toEqual(['P-001', 'P-002']);
  });

  it('one converted + one refused: partial failure — only the refused item fails', async () => {
    convM.mockImplementation(async (opts) =>
      opts.itemId === 'P-REF'
        ? ({ status: 'refused', reason: 'assigned to builder-2', assignee: 'builder-2' } as never)
        : converted(opts.itemId, 'WI-1'),
    );
    const b = await body({ plan: 'p1', itemIds: ['P-001', 'P-REF'] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, item: 'P-001', status: 'converted' });
    expect(b.results[1]).toMatchObject({ ok: false, item: 'P-REF', status: 'refused' });
  });

  it('a conflict is reported per item (ok:false) without failing the rest', async () => {
    convM.mockResolvedValue({ status: 'conflict', conflict: { owner: 'sess-B' } } as never);
    const b = await body({ plan: 'p1', item: 'P-001' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, item: 'P-001', status: 'conflict' });
  });

  it('the convert emits `dataOf` digs results[0] out of the envelope (pickup broadcast still fires)', () => {
    const emits = (tool as unknown as { emits: Array<{ fire: string; when: (e: unknown) => boolean }> }).emits;
    const broadcast = emits.find((r) => r.fire === 'coord:emit')!;
    const envelope = {
      result: {
        data: {
          ok: true,
          results: [{ ok: true, status: 'converted', workItem: { id: 'WI-1' }, planItem: { plan: 'p1', item: 'P-001', status: 'todo' } }],
          counts: { ok: 1, failed: 0 },
        },
      },
      ctx: {},
    };
    expect(broadcast.when(envelope)).toBe(true);
  });
});
