/**
 * emit.test.ts — events:emit envelope (GAP 6).
 *
 * Deps mocked (emitAwaitedEvent / resolveAgentIdentity). Asserts the emit
 * forwards source=identity.ownerId + workspaceId, and that the response shape is
 * { woken, notified: <count, not the array>, msg_id } off the engine result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-emitter', ownerLabel: 'e', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(),
}));

import emit from './emit';
import { emitAwaitedEvent } from '../../events/await/engine';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof emit.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await emit.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('events:emit envelope', () => {
  it('forwards source=identity.ownerId + workspaceId, and key/summary/payload/to', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k1', woken: 2, notified: ['a', 'b', 'c'], msgId: 'm-9' });
    await call({ event: 'k1', summary: 's', payload: { n: 1 }, to: ['x', 'y'] });
    expect(emitAwaitedEvent).toHaveBeenCalledWith({
      key: 'k1',
      summary: 's',
      payload: { n: 1 },
      to: ['x', 'y'],
      source: 'su-emitter',
      workspaceId: 'ws-x',
    });
  });

  it('response carries woken, notified=count (NOT the array), msg_id', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k2', woken: 5, notified: ['a', 'b', 'c'], msgId: 'm-42' });
    const out = await call({ event: 'k2' });
    expect(out).toEqual({ ok: true, event: 'k2', woken: 5, notified: 3, msg_id: 'm-42' });
    // notified must be the count, never the array.
    expect(Array.isArray(out.notified)).toBe(false);
  });

  it('null msgId + zero notify audience surface as msg_id:null, notified:0', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k3', woken: 0, notified: [], msgId: null });
    const out = await call({ event: 'k3' });
    expect(out).toMatchObject({ event: 'k3', woken: 0, notified: 0, msg_id: null });
  });
});
