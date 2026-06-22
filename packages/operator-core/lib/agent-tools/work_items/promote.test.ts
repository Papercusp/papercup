/**
 * promote.test.ts — the work_items:promote HANDLER (promoteToPipeline mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins: the inline
 * { id } single form → one result; the items:[…] many form → per-item results keyed
 * by id; an engine `{ error }` → that item's { ok:false } WITHOUT failing the batch;
 * a thrown engine error → { ok:false, id, error } via runBulk's keyOf; per-item harness
 * overrides the batch default; the minted feature fields ride the success result.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/promote.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ promoteToPipeline: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));

import { promoteToPipeline } from '../../work-items';
const promoteM = vi.mocked(promoteToPipeline);
const tool = (await import('./promote')).default;

type Out = { data: any };
const run = (args: unknown) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = async (args: unknown) => ((await run(args)).data);

beforeEach(() => vi.clearAllMocks());

describe('work_items:promote handler (bulk keyed-array)', () => {
  it('inline { id } promotes one and rides the minted feature fields on the result', async () => {
    promoteM.mockResolvedValue({ featureId: 'F-FIX-1', alreadyPipeline: false } as never);
    const b = await body({ id: 'WI-1', harness: 'papercup' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', featureId: 'F-FIX-1', alreadyPipeline: false });
    expect(promoteM).toHaveBeenCalledWith('WI-1', { harness: 'papercup', actor: 'me' });
  });

  it('items:[…] promotes many; an engine { error } fails only itself', async () => {
    promoteM.mockImplementation(async (id: string) =>
      (id === 'WI-X' ? ({ error: `work_item '${id}' not found` } as never) : ({ featureId: `F-${id}` } as never)),
    );
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-X' }, { id: 'WI-2' }] });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-1', true],
      ['WI-X', false],
      ['WI-2', true],
    ]);
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });

  it("a thrown engine error becomes that item's { ok:false, id, error } (batch survives)", async () => {
    promoteM.mockImplementation(async (id: string) => {
      if (id === 'WI-2') throw new Error('boom');
      return { featureId: `F-${id}` } as never;
    });
    const b = await body({ items: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toEqual({ ok: false, id: 'WI-2', error: 'boom' });
  });

  it('per-item harness overrides the batch default', async () => {
    promoteM.mockResolvedValue({ featureId: 'F' } as never);
    await body({ harness: 'def', items: [{ id: 'WI-1' }, { id: 'WI-2', harness: 'web' }] });
    expect(promoteM).toHaveBeenNthCalledWith(1, 'WI-1', { harness: 'def', actor: 'me' });
    expect(promoteM).toHaveBeenNthCalledWith(2, 'WI-2', { harness: 'web', actor: 'me' });
  });
});
