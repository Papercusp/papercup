/**
 * cancel.test.ts — events:cancel dual-path result (GAP 5).
 *
 * Deps mocked (cancelAwait / ackDelivery / resolveAgentIdentity). Asserts the
 * await_id-only / delivery_id-only / both result rules, and the asymmetric
 * ok-flip rule: an ack-miss only flips ok=false when await_id == null (so an
 * ack-miss riding alongside a successful cancel never poisons the result).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-canceller', ownerLabel: 'c', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/store', () => ({
  cancelAwait: vi.fn(),
  ackDelivery: vi.fn(),
}));

import cancel from './cancel';
import { cancelAwait, ackDelivery } from '../../events/await/store';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof cancel.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await cancel.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('events:cancel dual-path result', () => {
  it('cancel-only success → ok:true, cancelled:true, no reason', async () => {
    vi.mocked(cancelAwait).mockResolvedValue(true);
    const out = await call({ await_id: 7 });
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 7, subscriberId: 'su-canceller', workspaceId: 'ws-x' });
    expect(ackDelivery).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, await_id: 7, cancelled: true });
    expect(out.reason).toBeUndefined();
  });

  it('cancel-only miss → ok:false + the not_found reason', async () => {
    vi.mocked(cancelAwait).mockResolvedValue(false);
    const out = await call({ await_id: 7 });
    expect(out).toMatchObject({ ok: false, await_id: 7, cancelled: false, reason: 'not_found_or_not_yours_or_already_settled' });
  });

  it('ack-only success → ok:true, acked:true', async () => {
    vi.mocked(ackDelivery).mockResolvedValue(true);
    const out = await call({ delivery_id: 3 });
    expect(ackDelivery).toHaveBeenCalledWith({ deliveryId: 3, subscriberId: 'su-canceller' });
    expect(cancelAwait).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, delivery_id: 3, acked: true });
    expect(out.reason).toBeUndefined();
  });

  it('ack-only miss (await_id==null) → ok:false + reason', async () => {
    vi.mocked(ackDelivery).mockResolvedValue(false);
    const out = await call({ delivery_id: 3 });
    expect(out).toMatchObject({ ok: false, delivery_id: 3, acked: false, reason: 'not_found_or_not_yours_or_already_settled' });
  });

  it('both success → ok:true with both halves reported', async () => {
    vi.mocked(cancelAwait).mockResolvedValue(true);
    vi.mocked(ackDelivery).mockResolvedValue(true);
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out).toMatchObject({ ok: true, await_id: 7, cancelled: true, delivery_id: 3, acked: true });
    expect(out.reason).toBeUndefined();
  });

  it('asymmetric: ack-miss + cancel-success → ok STAYS true (the miss does not flip when await_id != null)', async () => {
    vi.mocked(cancelAwait).mockResolvedValue(true);
    vi.mocked(ackDelivery).mockResolvedValue(false);
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out).toMatchObject({ ok: true, cancelled: true, acked: false });
    expect(out.reason).toBeUndefined();
  });

  it('symmetric counter-case: cancel-miss + ack-success → ok flips false (cancel always flips)', async () => {
    vi.mocked(cancelAwait).mockResolvedValue(false);
    vi.mocked(ackDelivery).mockResolvedValue(true);
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out).toMatchObject({ ok: false, cancelled: false, acked: true, reason: 'not_found_or_not_yours_or_already_settled' });
  });
});
