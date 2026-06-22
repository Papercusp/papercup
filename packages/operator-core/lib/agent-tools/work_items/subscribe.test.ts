/**
 * subscribe.test.ts — work_items:subscribe HANDLER (subscribeWorkItem mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins: single `id`
 * → one result; `ids` → per-id results; an engine `{error}` → that id's { ok:false }
 * without failing the batch; shared mode/harness forwarded.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/subscribe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ subscribeWorkItem: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));

import { subscribeWorkItem } from '../../work-items';
const subM = vi.mocked(subscribeWorkItem);
const tool = (await import('./subscribe')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  subM.mockResolvedValue({} as never);
});

describe('work_items:subscribe handler (bulk keyed-array)', () => {
  it('single id subscribes once and returns one result', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, id: 'WI-1' });
    expect(subM).toHaveBeenCalledWith('me', 'WI-1', 'full', { harness: undefined });
  });

  it('ids[] with one engine error fails only that id', async () => {
    subM.mockImplementation(async (_owner: string, id: string) => (id === 'WI-X' ? ({ error: 'not found' } as never) : ({} as never)));
    const b = await body({ ids: ['WI-1', 'WI-X'], mode: 'digest', harness: 'web' });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results).toEqual([{ ok: true, id: 'WI-1' }, { ok: false, id: 'WI-X', error: 'not found' }]);
    expect(subM).toHaveBeenNthCalledWith(1, 'me', 'WI-1', 'digest', { harness: 'web' });
  });
});
