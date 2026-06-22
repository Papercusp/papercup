/**
 * comment.test.ts — the work_items:comment HANDLER (commentWorkItem mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins: the inline
 * { id, body } single form → one result; the items:[…] many form → per-item results
 * keyed by id; a not-found item → that item's { ok:false } WITHOUT failing the batch;
 * a thrown engine error → { ok:false, id, error } via runBulk's keyOf.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/comment.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ commentWorkItem: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));

import { commentWorkItem } from '../../work-items';
const cmtM = vi.mocked(commentWorkItem);
const tool = (await import('./comment')).default;

type Out = { data: any };
const run = (args: unknown) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = async (args: unknown) => ((await run(args)).data);

beforeEach(() => vi.clearAllMocks());

describe('work_items:comment handler (bulk keyed-array)', () => {
  it('inline { id, body } posts one comment and returns a single result', async () => {
    cmtM.mockResolvedValue({ id: 'post-1' } as never);
    const b = await body({ id: 'WI-1', body: 'hello' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', post: { id: 'post-1' } });
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'hello', 'me', { harness: undefined });
  });

  it('items:[…] comments on many; a not-found item fails only itself', async () => {
    cmtM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id: `post-${id}` } as never)));
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-X', body: 'b' }, { id: 'WI-2', body: 'c' }] });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-1', true],
      ['WI-X', false],
      ['WI-2', true],
    ]);
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });

  it('a thrown engine error becomes that item\'s { ok:false, id, error } (batch survives)', async () => {
    cmtM.mockImplementation(async (id: string) => {
      if (id === 'WI-2') throw new Error('boom');
      return { id: `post-${id}` } as never;
    });
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toEqual({ ok: false, id: 'WI-2', error: 'boom' });
  });

  it('per-item harness overrides the batch default', async () => {
    cmtM.mockResolvedValue({ id: 'p' } as never);
    await body({ harness: 'def', items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b', harness: 'web' }] });
    expect(cmtM).toHaveBeenNthCalledWith(1, 'WI-1', 'a', 'me', { harness: 'def' });
    expect(cmtM).toHaveBeenNthCalledWith(2, 'WI-2', 'b', 'me', { harness: 'web' });
  });
});
