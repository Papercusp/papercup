/**
 * reorder.test.ts — the work_items:reorder HANDLER (reorderWorkItem mocked). Pins the
 * writer default ('bee' when omitted), the explicit-writer passthrough (the propose/
 * dispose audit author), and the result branch: an 'error' result maps to { ok:false },
 * otherwise { ok:true, ...result }. A regression that defaults to the wrong writer or
 * reports a store error as success is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/reorder.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../work-items', () => ({ reorderWorkItem: vi.fn(), RANK_WRITERS: ['bee', 'queen'] }));

import { reorderWorkItem } from '../../work-items';
const reorderM = vi.mocked(reorderWorkItem);
const tool = (await import('./reorder')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler({ id: 'WI-1', rank: 0, ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  reorderM.mockResolvedValue({ rank: 0 } as never);
});

describe('work_items:reorder handler', () => {
  it("defaults the writer to 'bee'", async () => {
    await call({ rank: 1 });
    expect(reorderM).toHaveBeenCalledWith('WI-1', 1, { writer: 'bee', harness: undefined });
  });

  it("passes an explicit writer ('queen' overlay) through", async () => {
    await call({ rank: 2, writer: 'queen', harness: 'web' });
    expect(reorderM).toHaveBeenCalledWith('WI-1', 2, { writer: 'queen', harness: 'web' });
  });

  it('reports ok with the result on success', async () => {
    reorderM.mockResolvedValue({ rank: 3, assignee: 'bee-2' } as never);
    expect(body(await call({ rank: 3 }))).toMatchObject({ ok: true, rank: 3, assignee: 'bee-2' });
  });

  it('maps an error result to { ok:false }', async () => {
    reorderM.mockResolvedValue({ error: 'not_assigned' } as never);
    expect(body(await call({ rank: 0 }))).toMatchObject({ ok: false, error: 'not_assigned' });
  });
});
