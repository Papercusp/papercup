/**
 * substrate-outbox-keepalive.test.ts — unit tests for the process-global
 * outbox NOTIFY keepalive (AC#2 / P-008 re-boot-on-NOTIFY).
 *
 * Uses a fakePg() that captures the pg.listen callback without a real PG
 * connection; mocks '../boot-all' to spy on handleOutboxNotifyForEvictedHarness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSubstrateOutboxKeepalive } from '../substrate-outbox-keepalive';

// Spy on the handler imported by the keepalive module.
vi.mock('../boot-all', () => ({
  handleOutboxNotifyForEvictedHarness: vi.fn(),
}));

import { handleOutboxNotifyForEvictedHarness } from '../boot-all';
const mockHandle = handleOutboxNotifyForEvictedHarness as ReturnType<typeof vi.fn>;

/** Minimal postgres.Sql fake that captures the LISTEN callback. */
function fakePg() {
  let capturedChannel: string | null = null;
  let capturedCallback: ((payload: string) => void) | null = null;
  let unlistenCalled = false;

  const unlisten = vi.fn(async () => {
    unlistenCalled = true;
  });

  const listenReq = vi.fn(async (channel: string, cb: (payload: string) => void) => {
    capturedChannel = channel;
    capturedCallback = cb;
    return { unlisten };
  });

  // Emit simulates PG sending a NOTIFY.
  const emit = (payload: string): void => {
    capturedCallback?.(payload);
  };

  return {
    sql: { listen: listenReq } as unknown as import('postgres').Sql,
    capturedChannel: () => capturedChannel,
    emit,
    unlisten,
    unlistenCalled: () => unlistenCalled,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('startSubstrateOutboxKeepalive', () => {
  it('calls handleOutboxNotifyForEvictedHarness with parsed workspaceId + slug on matching NOTIFY', async () => {
    const pg = fakePg();
    startSubstrateOutboxKeepalive(pg.sql);
    await Promise.resolve(); // flush listenReq promise (callback is captured synchronously)

    pg.emit('my-workspace::my-harness');
    expect(mockHandle).toHaveBeenCalledExactlyOnceWith('my-workspace', 'my-harness');
  });

  it('handles multiple NOTIFYs for different harnesses', async () => {
    const pg = fakePg();
    startSubstrateOutboxKeepalive(pg.sql);
    await Promise.resolve();

    pg.emit('ws-a::harness-1');
    pg.emit('ws-b::harness-2');
    expect(mockHandle).toHaveBeenCalledTimes(2);
    expect(mockHandle).toHaveBeenNthCalledWith(1, 'ws-a', 'harness-1');
    expect(mockHandle).toHaveBeenNthCalledWith(2, 'ws-b', 'harness-2');
  });

  it('ignores malformed payloads (no "::" separator)', async () => {
    const pg = fakePg();
    startSubstrateOutboxKeepalive(pg.sql);
    await Promise.resolve();

    pg.emit('malformed-no-separator');
    pg.emit('');
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('ignores NOTIFYs received after stop()', async () => {
    const pg = fakePg();
    const handle = startSubstrateOutboxKeepalive(pg.sql);
    await Promise.resolve();

    await handle.stop();
    pg.emit('ws::harness');
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('stop() is idempotent — second call does not throw or double-unlisten', async () => {
    const pg = fakePg();
    const handle = startSubstrateOutboxKeepalive(pg.sql);
    await Promise.resolve();

    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(pg.unlisten).toHaveBeenCalledOnce();
  });
});
