/**
 * tag.test.ts — work_items:tag handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * → one result; ids:[…]+topic homogeneous fan-out; items:[…] heterogeneous; remove:true
 * routes to untag; an engine {error} fails only that item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({ tagWorkItem: vi.fn(), untagWorkItem: vi.fn() }));

import { tagWorkItem, untagWorkItem } from '../../work-items';
const tagM = vi.mocked(tagWorkItem);
const untagM = vi.mocked(untagWorkItem);
const tool = (await import('./tag')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  tagM.mockResolvedValue({ ok: true } as never);
  untagM.mockResolvedValue({ ok: true } as never);
});

describe('work_items:tag handler (keyed-array)', () => {
  it('tags one inline and returns a single result', async () => {
    const b = await body({ id: 'WI-1', topic: 'infra' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, id: 'WI-1', topic: 'infra' });
    expect(tagM).toHaveBeenCalledWith('WI-1', 'infra', { harness: undefined, by: 'me' });
  });

  it('tags MANY with the same topic via ids:[…] (homogeneous)', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], topic: 'infra', harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-1', 'WI-2']);
    expect(tagM).toHaveBeenCalledWith('WI-2', 'infra', { harness: 'h', by: 'me' });
  });

  it('items:[…] heterogeneous; remove:true routes to untag', async () => {
    const b = await body({ items: [{ id: 'WI-1', topic: 'a' }, { id: 'WI-2', topic: 'b', remove: true }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(untagM).toHaveBeenCalledWith('WI-2', 'b', { harness: undefined });
    expect(tagM).toHaveBeenCalledWith('WI-1', 'a', { harness: undefined, by: 'me' });
  });

  it('an engine {error} fails only that item', async () => {
    tagM.mockImplementation(async (id: string) => (id === 'WI-BAD' ? ({ error: 'not found' } as never) : ({ ok: true } as never)));
    const b = await body({ ids: ['WI-1', 'WI-BAD'], topic: 'x' });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-BAD', error: 'not found' });
  });
});
