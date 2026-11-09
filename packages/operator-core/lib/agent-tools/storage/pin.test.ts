import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ createRetentionPin: vi.fn(), readRetentionPins: vi.fn(), removeRetentionPin: vi.fn(),
  withFsMutex: vi.fn(async (_name: string, run: () => Promise<unknown>) => run()) }));
vi.mock('../../storage/retention-pins', () => h);
vi.mock('../../../../../scripts/lib/fs-mutex.mjs', () => ({ withFsMutex: h.withFsMutex }));
vi.mock('../locks/identity', () => ({ readIdentity: () => ({ ownerId: 'authenticated-agent' }) }));
import tool from './pin';

beforeEach(() => vi.clearAllMocks());
describe('storage:pin', () => {
  it('requires a reason and expiry for creation, without accepting a caller-supplied owner', () => {
    expect(tool.args.safeParse({ op: 'pin', path: '/tmp/output' }).success).toBe(false);
    expect(tool.args.safeParse({ op: 'pin', path: '/tmp/output', reason: ' ', expiresAt: '2026-12-01T00:00:00Z' }).success).toBe(false);
    expect(tool.args.safeParse({ op: 'pin', path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z', owner: 'impersonated' }).success).toBe(false);
  });

  it('writes and releases pins using the authenticated identity', async () => {
    const pin = { id: 'pin-id' }; h.createRetentionPin.mockReturnValue(pin); h.removeRetentionPin.mockReturnValue(true);
    // Preserve the historical ordinary inputs, including the wire schema that
    // dispatch applies before the handler. No new worker field or call is added.
    const create = tool.args.parse({ op: 'pin', path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z' });
    expect(await tool.handler(create, {} as never))
      .toEqual({ data: { ok: true, op: 'pin', pin } });
    expect(h.createRetentionPin).toHaveBeenCalledWith({ path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z', owner: 'authenticated-agent' });
    expect(h.createRetentionPin).toHaveBeenCalledTimes(1);
    expect(h.withFsMutex).toHaveBeenCalledWith('papercusp-disk-retention', expect.any(Function), {});
    const release = tool.args.parse({ op: 'unpin', id: '58e49cc6-dd34-4438-b182-c13892d39a2e' });
    expect(await tool.handler(release, {} as never)).toEqual({ data: {
      ok: true, op: 'unpin', id: '58e49cc6-dd34-4438-b182-c13892d39a2e', removed: true,
    } });
    expect(h.removeRetentionPin).toHaveBeenCalledWith('58e49cc6-dd34-4438-b182-c13892d39a2e', 'authenticated-agent');
    expect(h.removeRetentionPin).toHaveBeenCalledTimes(1);
    expect(h.withFsMutex).toHaveBeenCalledTimes(2);
  });

  it('bounds retention-mutex admission to the remaining host deadline when one exists', async () => {
    const nowMs = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    h.createRetentionPin.mockReturnValue({ id: 'pin-id' });

    try {
      const input = { op: 'pin', path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z' };
      const args = tool.args.parse(input);
      expect(args).toEqual(input);
      expect(await tool.handler(
        args,
        { deadlineAtMs: nowMs + 10_000 } as never,
      )).toEqual({ data: { ok: true, op: 'pin', pin: { id: 'pin-id' } } });
      expect(h.withFsMutex).toHaveBeenCalledWith('papercusp-disk-retention', expect.any(Function), { timeoutMs: 9_000 });
      expect(h.withFsMutex).toHaveBeenCalledTimes(1);
      expect(h.createRetentionPin).toHaveBeenCalledTimes(1);
      expect(h.createRetentionPin).toHaveBeenCalledWith({ path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z', owner: 'authenticated-agent' });
      expect(h.readRetentionPins).not.toHaveBeenCalled();
      expect(h.removeRetentionPin).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('reports an unreadable lease store as an error on listing', async () => {
    h.readRetentionPins.mockReturnValue({ pins: [], errors: ['corrupt lease'] });
    const input = { op: 'list', includeExpired: true };
    const args = tool.args.parse(input);
    expect(args).toEqual(input);
    expect(await tool.handler(args, {} as never))
      .toEqual({ data: { ok: false, op: 'list', pins: [], errors: ['corrupt lease'] }, isError: true });
    expect(h.readRetentionPins).toHaveBeenCalledWith({ includeExpired: true });
    expect(h.readRetentionPins).toHaveBeenCalledTimes(1);
    expect(h.withFsMutex).not.toHaveBeenCalled();
    expect(h.createRetentionPin).not.toHaveBeenCalled();
    expect(h.removeRetentionPin).not.toHaveBeenCalled();
  });

  it('records exact mutation identities while treating lists and absent releases as no effect', () => {
    const receipt = tool.abortCompletionReceipt!;
    const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
    expect(receipt({ op: 'pin', path: '/tmp/output', reason: 'review', expiresAt: '2026-12-01T00:00:00Z' }, result({ ok: true, op: 'pin', pin: { id: 'pin-id' } }), {} as never))
      .toEqual({ status: 'recorded', effectRef: 'retention-pin:pin-id:pin' });
    expect(receipt({ op: 'unpin', id: '58e49cc6-dd34-4438-b182-c13892d39a2e' }, result({ ok: true, op: 'unpin', id: 'pin-id', removed: true }), {} as never))
      .toEqual({ status: 'recorded', effectRef: 'retention-pin:pin-id:unpin' });
    expect(receipt({ op: 'list' }, result({ ok: true, op: 'list' }), {} as never)).toMatchObject({ status: 'not-recorded' });
    expect(receipt({ op: 'unpin', id: '58e49cc6-dd34-4438-b182-c13892d39a2e' }, result({ ok: true, op: 'unpin', removed: false }), {} as never)).toMatchObject({ status: 'not-recorded' });
    expect(receipt({ op: 'list' }, result({ ok: false }), {} as never)).toMatchObject({ status: 'recovery-incomplete' });
  });
});
