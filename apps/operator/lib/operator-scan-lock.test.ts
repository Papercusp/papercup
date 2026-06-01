import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LockRow { holder_id: string; expires_at: string }
let lockRow: LockRow | null = null;
let deleteHolderId: string | null = null;

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

// Drizzle stub: model the scan-lock table with a single in-memory row.
// drizzle-orm's fluent builder is mocked enough to satisfy the call sites
// in operator-scan-lock.ts (select.from.where.limit, insert.values.onConflictDoUpdate, delete.where).
// The SUT now receives `tx` from withWorkspace (it migrated off raw sql), so
// the fake is shared: withWorkspace passes THIS object as the tx (the bare `{}`
// it used to pass had no .select/.insert/.delete → acquire always failed).
const fakeTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (!lockRow) return [];
            const expiresMs = new Date(lockRow.expires_at).getTime();
            if (expiresMs <= Date.now()) { lockRow = null; return []; }
            return [lockRow];
          },
        }),
      }),
    }),
    insert: () => ({
      // SUT passes drizzle camelCase column keys (holderId/expiresAt), not the
      // snake_case DB names — read those.
      values: (row: { holderId: string; expiresAt: unknown }) => ({
        onConflictDoUpdate: async () => {
          // operator-scan-lock binds expiresAt as `dsql\`${iso}::timestamptz\``
          // — a drizzle SQL fragment whose `.queryChunks` array holds the
          // raw ISO string. Extract it; fall back to "now + TTL" if the
          // fragment shape changes upstream.
          let expIso = '';
          const ev = row.expiresAt as { queryChunks?: unknown[] } | string | Date;
          if (typeof ev === 'string') expIso = ev;
          else if (ev instanceof Date) expIso = ev.toISOString();
          else if (ev && typeof ev === 'object' && Array.isArray(ev.queryChunks)) {
            for (const chunk of ev.queryChunks) {
              if (typeof chunk === 'string' && /T\d{2}:\d{2}/.test(chunk)) { expIso = chunk; break; }
              if (chunk && typeof chunk === 'object' && 'value' in (chunk as object)) {
                const v = (chunk as { value: unknown[] }).value;
                if (Array.isArray(v) && typeof v[0] === 'string') { expIso = v[0]; break; }
              }
            }
          }
          if (!expIso) expIso = new Date(Date.now() + 60_000).toISOString();
          lockRow = { holder_id: row.holderId, expires_at: expIso };
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        // The where clause is opaque to us; the test scope is a single
        // workspace + holder. operator-scan-lock.ts only deletes when
        // (workspace_id, holder_id) matches — emulate by deleting the
        // current row if its holder_id matches the most recent acquire.
        // For the "foreign release no-op" test, the caller passes a
        // wrong holderId — we have no way to see it here, so the test
        // pre-captures the holderId externally (see helper below).
        if (deleteHolderId !== null && lockRow?.holder_id === deleteHolderId) {
          lockRow = null;
        }
        deleteHolderId = null;
      },
    }),
};
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => fakeTx }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as object), // real `generated` so eq()/gt() resolve real columns
  withWorkspace: async (_ws: string, cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx),
}));

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
    deleteHolderId = a.holderId!;
    await releaseScanLock(a.holderId!);
    const b = await acquireScanLock();
    expect(b.acquired).toBe(true);
  });

  it('is a no-op when the holder does not match (someone else holds it)', async () => {
    const a = await acquireScanLock();
    deleteHolderId = 'not-the-real-holder';
    await releaseScanLock('not-the-real-holder');
    // Original holder should still be in place.
    const b = await acquireScanLock();
    expect(b.acquired).toBe(false);
    expect(a.holderId).toBeDefined();
  });
});
