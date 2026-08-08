import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the two delivery channels + workspace resolution so we can assert
// notifyAttention fans out correctly without real PG / APNs. vi.hoisted so
// the fns exist when the hoisted vi.mock factories run.
//
// notifyWorkspace's REAL return type is PushSendResult[] (empty when no device is paired) —
// WI-36644's outcome derivation reads that array, so the mock must return one too, not
// `undefined`, or it would exercise a shape the real implementation never produces.
const { notifyWorkspace, notifySyncInvalidate, recordAttentionNotifyIntent, recordAttentionNotifyOutcome } =
  vi.hoisted(() => ({
    notifyWorkspace: vi.fn(async (..._a: unknown[]): Promise<Array<{ platform: string; ok: boolean; status: unknown; detail?: string }>> => []),
    notifySyncInvalidate: vi.fn(async (..._a: unknown[]) => {}),
    recordAttentionNotifyIntent: vi.fn(async (..._a: unknown[]) => 1),
    recordAttentionNotifyOutcome: vi.fn(async (..._a: unknown[]) => {}),
  }));
vi.mock('./device-push-dispatcher', () => ({ notifyWorkspace }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('./attention-notify-store', () => ({ recordAttentionNotifyIntent, recordAttentionNotifyOutcome }));

import { notifyAttention, ATTENTION_NOTIFY_EVENT } from './attention-notify';

afterEach(() => {
  notifyWorkspace.mockClear();
  notifySyncInvalidate.mockClear();
  recordAttentionNotifyIntent.mockClear();
  recordAttentionNotifyOutcome.mockClear();
  notifyWorkspace.mockImplementation(async () => []);
  notifySyncInvalidate.mockImplementation(async () => {});
  recordAttentionNotifyIntent.mockImplementation(async () => 1);
  recordAttentionNotifyOutcome.mockImplementation(async () => {});
});

describe('notifyAttention', () => {
  it('fans out to BOTH the mobile and desktop channels', async () => {
    await notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B', harnessSlug: 'h1', importance: 'high' });
    expect(notifyWorkspace).toHaveBeenCalledTimes(1);
    expect(notifySyncInvalidate).toHaveBeenCalledTimes(1);
    expect(notifySyncInvalidate.mock.calls[0][0]).toBe(ATTENTION_NOTIFY_EVENT);
  });

  it('defaults the workspace to the active one', async () => {
    await notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B' });
    expect(notifyWorkspace.mock.calls[0][0]).toBe('ws-test');
  });

  it('maps needs-human to the intervention PushKind and keeps mobile data string-only', async () => {
    await notifyAttention({
      kind: 'needs-human',
      title: 'T',
      body: 'B',
      harnessSlug: 'h1',
      importance: 'urgent',
      data: { plan: 'p', item: 'P-001' },
    });
    const payload = notifyWorkspace.mock.calls[0][1] as {
      data: Record<string, string>;
      category: string;
    };
    expect(payload.category).toBe('intervention');
    expect(payload.data.kind).toBe('intervention');
    expect(payload.data).toEqual({
      kind: 'intervention',
      harness: 'h1',
      importance: 'urgent',
      plan: 'p',
      item: 'P-001',
    });
    // every value is a string (APNs/FCM constraint)
    for (const v of Object.values(payload.data)) expect(typeof v).toBe('string');
  });

  it('omits nullish optional fields from mobile data', async () => {
    await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
    const payload = notifyWorkspace.mock.calls[0][1] as { data: Record<string, string> };
    expect(payload.data).toEqual({ kind: 'intervention' });
  });

  it('still fires the desktop channel when the mobile push throws (fail-safe, independent)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifyWorkspace.mockImplementationOnce(async () => {
      throw new Error('apns down');
    });
    await expect(
      notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B' }),
    ).resolves.toBeUndefined();
    expect(notifySyncInvalidate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // WI-36644 — the durable audit trail: "was the human ever told?" must be a query, not a guess.
  describe('durable audit trail (WI-36644)', () => {
    it('records intent BEFORE attempting either channel, tagged with the resolved workspace', async () => {
      const order: string[] = [];
      recordAttentionNotifyIntent.mockImplementationOnce(async () => {
        order.push('intent');
        return 7;
      });
      notifyWorkspace.mockImplementationOnce(async () => {
        order.push('mobile');
        return [];
      });
      notifySyncInvalidate.mockImplementationOnce(async () => {
        order.push('desktop');
      });
      await notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B', harnessSlug: 'h1' });
      expect(order).toEqual(['intent', 'mobile', 'desktop']);
      expect(recordAttentionNotifyIntent).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-test', harnessSlug: 'h1', kind: 'smoke-fail', title: 'T', body: 'B' }),
      );
    });

    it('records mobile succeeded:false with "no push targets" when notifyWorkspace resolves empty (the documented no-op case) — a resolved call is NOT itself evidence of delivery', async () => {
      notifyWorkspace.mockImplementationOnce(async () => []);
      await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'mobile',
        expect.objectContaining({ attempted: true, succeeded: false, error: expect.stringContaining('no push targets') }),
      );
    });

    it('records mobile succeeded:true when at least one PushSendResult is ok', async () => {
      notifyWorkspace.mockImplementationOnce(async () => [
        { platform: 'fcm', ok: true, status: 200 },
        { platform: 'apns', ok: false, status: 'skipped' },
      ]);
      await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'mobile',
        expect.objectContaining({ attempted: true, succeeded: true }),
      );
    });

    it('records mobile succeeded:false with a per-target detail when every target failed (not a throw)', async () => {
      notifyWorkspace.mockImplementationOnce(async () => [
        { platform: 'fcm', ok: false, status: 'error', detail: 'invalid token' },
      ]);
      await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'mobile',
        expect.objectContaining({ attempted: true, succeeded: false, error: expect.stringContaining('invalid token') }),
      );
    });

    it('records the mobile outcome as failed with the thrown message when notifyWorkspace itself throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      notifyWorkspace.mockImplementationOnce(async () => {
        throw new Error('apns down');
      });
      await notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'mobile',
        expect.objectContaining({ attempted: true, succeeded: false, error: 'apns down' }),
      );
      vi.restoreAllMocks();
    });

    it('records the desktop outcome as succeeded when the SSE emit does not throw, and failed with the message when it does', async () => {
      await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'desktop',
        expect.objectContaining({ attempted: true, succeeded: true }),
      );

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      notifySyncInvalidate.mockImplementationOnce(async () => {
        throw new Error('sse bus down');
      });
      await notifyAttention({ kind: 'intervention', title: 'T', body: 'B' });
      expect(recordAttentionNotifyOutcome).toHaveBeenCalledWith(
        1,
        'ws-test',
        'desktop',
        expect.objectContaining({ attempted: true, succeeded: false, error: 'sse bus down' }),
      );
      vi.restoreAllMocks();
    });

    it('never throws when recording the intent itself fails (audit write is best-effort, matching the two delivery channels)', async () => {
      recordAttentionNotifyIntent.mockImplementationOnce(async () => null);
      await expect(
        notifyAttention({ kind: 'smoke-fail', title: 'T', body: 'B' }),
      ).resolves.toBeUndefined();
      expect(notifyWorkspace).toHaveBeenCalledTimes(1);
      expect(notifySyncInvalidate).toHaveBeenCalledTimes(1);
    });
  });
});
