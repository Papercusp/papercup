import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LockRow { holder_id: string; expires_at: string }
let lockRow: LockRow | null = null;

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

vi.mock('@restart/db-org', () => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    if (/SELECT holder_id, expires_at[\s\S]*FROM harness_shared\.operator_scan_locks[\s\S]*expires_at > now\(\)/.test(sqlText)) {
      if (!lockRow) return Promise.resolve([]);
      const expiresMs = new Date(lockRow.expires_at).getTime();
      if (expiresMs <= Date.now()) {
        lockRow = null;
        return Promise.resolve([]);
      }
      return Promise.resolve([lockRow]);
    }
    if (/INSERT INTO harness_shared\.operator_scan_locks/.test(sqlText)) {
      lockRow = {
        holder_id: values[1] as string,
        expires_at: values[2] as string,
      };
      return Promise.resolve([]);
    }
    if (/DELETE FROM harness_shared\.operator_scan_locks/.test(sqlText)) {
      const holderId = values[1] as string;
      if (lockRow?.holder_id === holderId) lockRow = null;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }
  return {
    withWorkspace: async (_ws: string, cb: (tx: typeof tagged) => Promise<unknown>) => cb(tagged),
  };
});

import { acquireScanLock, releaseScanLock } from './operator-scan-lock';

beforeEach(() => { lockRow = null; });
afterEach(() => { lockRow = null; });

describe('acquireScanLock', () => {
  it('acquires an unheld lock and returns the holder id', async () => {
    const r = await acquireScanLock();
    expect(r.acquired).toBe(true);
    expect(typeof r.holderId).toBe('string');
    expect(r.holderId!.length).toBeGreaterThan(8);
  });

  it('refuses a second concurrent acquisition (returns retry-after)', async () => {
    const a = await acquireScanLock();
    expect(a.acquired).toBe(true);
    const b = await acquireScanLock();
    expect(b.acquired).toBe(false);
    expect(b.retryAfterSec).toBeGreaterThan(0);
    expect(b.retryAfterSec).toBeLessThanOrEqual(60);
    expect(b.holderId).toBeUndefined();
  });

  it('re-acquires after the TTL expires', async () => {
    const a = await acquireScanLock();
    expect(a.acquired).toBe(true);
    // Backdate the lock past the 60s TTL.
    if (lockRow) lockRow.expires_at = new Date(Date.now() - 1000).toISOString();
    const b = await acquireScanLock();
    expect(b.acquired).toBe(true);
    expect(b.holderId).not.toBe(a.holderId);
  });
});

describe('releaseScanLock', () => {
  it('removes the lock when the holder matches', async () => {
    const a = await acquireScanLock();
    await releaseScanLock(a.holderId!);
    const b = await acquireScanLock();
    expect(b.acquired).toBe(true);
  });

  it('is a no-op when the holder does not match (someone else holds it)', async () => {
    const a = await acquireScanLock();
    await releaseScanLock('not-the-real-holder');
    // Original holder should still be in place.
    const b = await acquireScanLock();
    expect(b.acquired).toBe(false);
    expect(a.holderId).toBeDefined();
  });
});
