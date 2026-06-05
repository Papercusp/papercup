/**
 * Tests for the cross-surface voice lease. Mocks @papercusp/db-org so the
 * claim/release/preempt logic runs without a live PG.
 *
 * The SUT migrated from raw `sql\`\`` to Drizzle's `getOrgPg().db` query
 * builder, so the mock provides a chainable fake `db` (each call resolves to
 * the next queued result) and keeps the REAL `generated` table defs (via
 * importActual) so drizzle's `eq`/`and` operators resolve real columns. The
 * old raw-SQL-string assertions tested an implementation that no longer
 * exists and were dropped; the behavioral assertions are unchanged.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Rows returned by each `db.select(...).from(...).where(...)` await, in order.
const selectQueue: unknown[][] = [];
// Operations issued through the fake `db`, for behavioral assertions.
const dbOps: string[] = [];

/** A chainable, awaitable stand-in for a drizzle query — every method returns
 *  the chain; awaiting it resolves to `result`. */
function thenable(result: unknown): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return () => thenable(result);
    },
  });
}

const fakeDb = {
  select: () => thenable(selectQueue.shift() ?? []),
  insert: () => {
    dbOps.push('insert');
    return thenable([]);
  },
  delete: () => {
    dbOps.push('delete');
    return thenable([]);
  },
};

vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as object), // real `generated` so eq()/and() resolve real columns
  getOrgPg: () => ({
    sql: Object.assign(() => Promise.resolve([]), {
      unsafe: () => Promise.resolve([]), // unused now (table is migration-sourced)
    }),
    db: fakeDb,
  }),
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(() => Promise.resolve()) }));

import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from './voice-lease';
import { notifySyncInvalidate } from './sync-sse';

beforeEach(() => {
  selectQueue.length = 0;
  dbOps.length = 0;
  (notifySyncInvalidate as any).mockClear();
});

describe('claimVoiceLease', () => {
  it('grants the lease when no prior row exists', async () => {
    selectQueue.push([]); // SELECT current → none
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-A', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerId).toBe('tab-A');
    expect(out.lease.ownerKind).toBe('desktop');
    expect(out.lease.expiresAtMs).toBeGreaterThan(Date.now());
    expect(dbOps).toContain('insert');
    // notifySyncInvalidate fires only on owner change. From-empty counts.
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });

  it('grants and refreshes for the same owner without notifying', async () => {
    selectQueue.push([{ ownerId: 'tab-A', ownerKind: 'desktop', expiresAtMs: Date.now() + 5000 }]);
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-A', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('refuses when a different owner holds a non-expired lease', async () => {
    selectQueue.push([{ ownerId: 'tab-A', ownerKind: 'desktop', expiresAtMs: Date.now() + 5000 }]);
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-B', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(false);
    expect(out.lease.ownerId).toBe('tab-A');
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('takes the lease when the prior holder has expired', async () => {
    selectQueue.push([{ ownerId: 'tab-A', ownerKind: 'desktop', expiresAtMs: Date.now() - 5000 }]);
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-B', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerId).toBe('tab-B');
    expect(notifySyncInvalidate).toHaveBeenCalled();
  });

  it('force=true preempts an active different owner', async () => {
    // force skips the SELECT and inserts directly
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'phone-1', ownerKind: 'mobile', force: true,
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerKind).toBe('mobile');
    expect(dbOps).toContain('insert');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });
});

describe('releaseVoiceLease', () => {
  it('deletes the row and notifies', async () => {
    await releaseVoiceLease({ workspaceId: 'ws-1', ownerId: 'tab-A' });
    expect(dbOps).toContain('delete');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });
});

describe('readVoiceLease', () => {
  it('returns null when no lease exists', async () => {
    selectQueue.push([]);
    expect(await readVoiceLease('ws-x')).toBeNull();
  });

  it('returns the parsed lease when active', async () => {
    selectQueue.push([{ ownerId: 'p1', ownerKind: 'mobile', expiresAtMs: Date.now() + 8000 }]);
    const lease = await readVoiceLease('ws-x');
    expect(lease).not.toBeNull();
    expect(lease!.ownerKind).toBe('mobile');
  });

  it('returns null when the active lease has expired (filtered in WHERE)', async () => {
    // The WHERE filters expired rows server-side; an empty result models that.
    selectQueue.push([]);
    expect(await readVoiceLease('ws-x')).toBeNull();
  });
});
