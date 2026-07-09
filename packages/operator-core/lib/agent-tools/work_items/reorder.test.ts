/**
 * reorder.test.ts — the work_items:reorder HANDLER (reorderWorkItem mocked). Pins the
 * writer default ('cup' when omitted), the explicit-writer passthrough (the propose/
 * dispose audit author), and the result branch: an 'error' result maps to { ok:false },
 * otherwise { ok:true, ...result }. A regression that defaults to the wrong writer or
 * reports a store error as success is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/reorder.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../work-items', () => ({ reorderWorkItem: vi.fn(), RANK_WRITERS: ['cup', 'mug'] }));

import { reorderWorkItem } from '../../work-items';
const reorderM = vi.mocked(reorderWorkItem);
const tool = (await import('./reorder')).default;

type Out = { data: any };
const call = (args: Record<string, unknown>) => tool.handler({ id: 'WI-1', rank: 0, ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data);

beforeEach(() => {
  vi.clearAllMocks();
  reorderM.mockResolvedValue({ rank: 0 } as never);
});

describe('work_items:reorder handler (bulk keyed-array)', () => {
  it("defaults the writer to 'cup' (inline single)", async () => {
    await call({ rank: 1 });
    expect(reorderM).toHaveBeenCalledWith('WI-1', 1, { writer: 'cup', harness: undefined });
  });

  it("passes an explicit writer ('mug' overlay) through", async () => {
    await call({ rank: 2, writer: 'mug', harness: 'web' });
    expect(reorderM).toHaveBeenCalledWith('WI-1', 2, { writer: 'mug', harness: 'web' });
  });

  it('reports ok with the result as the item result on success', async () => {
    reorderM.mockResolvedValue({ rank: 3, assignee: 'bee-2' } as never);
    expect(body(await call({ rank: 3 })).results[0]).toMatchObject({ ok: true, id: 'WI-1', rank: 3, assignee: 'bee-2' });
  });

  it('maps an error result to that item\'s { ok:false } without failing the batch', async () => {
    reorderM.mockResolvedValue({ error: 'not_assigned' } as never);
    const b = body(await call({ rank: 0 }));
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-1', error: 'not_assigned' });
  });

  it('reorders MANY items in one call (items:[…]), keyed by id', async () => {
    reorderM.mockImplementation(async (id: string, rank: number) => ({ rank, assignee: `a-${id}` } as never));
    const b = body(await tool.handler({ items: [{ id: 'WI-1', rank: 0 }, { id: 'WI-2', rank: 1, writer: 'mug' }] } as never, {} as never) as Out);
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-1', 'WI-2']);
    expect(reorderM).toHaveBeenNthCalledWith(2, 'WI-2', 1, { writer: 'mug', harness: undefined });
  });
});
