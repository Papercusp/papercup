import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the two delivery channels + workspace resolution so we can assert
// notifyAttention fans out correctly without real PG / APNs. vi.hoisted so
// the fns exist when the hoisted vi.mock factories run.
const { notifyWorkspace, notifySyncInvalidate } = vi.hoisted(() => ({
  notifyWorkspace: vi.fn(async (..._a: unknown[]) => {}),
  notifySyncInvalidate: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock('./device-push-dispatcher', () => ({ notifyWorkspace }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { notifyAttention, ATTENTION_NOTIFY_EVENT } from './attention-notify';

afterEach(() => {
  notifyWorkspace.mockClear();
  notifySyncInvalidate.mockClear();
  notifyWorkspace.mockImplementation(async () => {});
  notifySyncInvalidate.mockImplementation(async () => {});
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
});
