/**
 * status.test.ts — events:status projection (GAP 15).
 *
 * Deps mocked (listActiveAwaits / listRecentDeliveries / wakeMeter /
 * resolveAgentIdentity). Asserts the projected field names (await_id/event/policy
 * for awaits; delivery_id/channel/last_error for deliveries), that the meter is
 * omitted unless meter:true, and that all three store reads run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-status', ownerLabel: 's', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/store', () => ({
  listActiveAwaits: vi.fn(),
  listRecentDeliveries: vi.fn(),
  wakeMeter: vi.fn(),
}));

import status from './status';
import { listActiveAwaits, listRecentDeliveries, wakeMeter } from '../../events/await/store';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof status.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await status.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

const AWAIT_ROW = { id: 11, eventKey: 'lock:grant:t1', policy: 'wake', note: 'n', expiresTs: 'E', timeoutBehavior: 'wake', createdAt: 'C' };
const DELIVERY_ROW = { id: 22, eventKey: 'lock:grant:t1', status: 'parked', channel: 'inbox', attempts: 2, lastError: 'boom', createdAt: 'C2', deliveredAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listActiveAwaits).mockResolvedValue([AWAIT_ROW] as never);
  vi.mocked(listRecentDeliveries).mockResolvedValue([DELIVERY_ROW] as never);
  vi.mocked(wakeMeter).mockResolvedValue({ total: 7 } as never);
});

describe('events:status projection', () => {
  it('projects await rows to await_id/event/policy/note/expires_ts/on_timeout/created_at', async () => {
    const out = await call({});
    expect(out.active_awaits[0]).toEqual({
      await_id: 11,
      event: 'lock:grant:t1',
      policy: 'wake',
      note: 'n',
      expires_ts: 'E',
      on_timeout: 'wake',
      created_at: 'C',
    });
  });

  it('projects delivery rows to delivery_id/event/status/channel/last_error/...', async () => {
    const out = await call({});
    expect(out.recent_wakes[0]).toEqual({
      delivery_id: 22,
      event: 'lock:grant:t1',
      status: 'parked',
      channel: 'inbox',
      attempts: 2,
      last_error: 'boom',
      created_at: 'C2',
      delivered_at: null,
    });
  });

  it('meter omitted unless meter:true (default call → wakeMeter NOT invoked, no meter key)', async () => {
    const out = await call({});
    expect(wakeMeter).not.toHaveBeenCalled();
    expect('meter' in out).toBe(false);
  });

  it('meter:true → wakeMeter invoked with the workspaceId and the meter rides in the envelope', async () => {
    const out = await call({ meter: true });
    expect(wakeMeter).toHaveBeenCalledWith({ workspaceId: 'ws-x' });
    expect(out.meter).toEqual({ total: 7 });
  });

  it('all three store reads run (Promise.all), scoped to identity', async () => {
    await call({ meter: true });
    expect(listActiveAwaits).toHaveBeenCalledWith('su-status', 'ws-x');
    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 10);
    expect(wakeMeter).toHaveBeenCalledTimes(1);
  });
});
