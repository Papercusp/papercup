/**
 * Tests for the cross-surface voice lease. Mocks @papercusp/db-org so the
 * claim/release/preempt logic runs without a live PG.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];
const sqlQueue: unknown[][] = [];
let lastUnsafe = '';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqlCalls.push({ strings, values });
        return Promise.resolve(sqlQueue.shift() ?? []);
      },
      {
        unsafe: (text: string) => { lastUnsafe = text; return Promise.resolve([]); },
      },
    ),
  }),
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(() => Promise.resolve()) }));

import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from './voice-lease';
import { notifySyncInvalidate } from './sync-sse';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlQueue.length = 0;
  lastUnsafe = '';
  (notifySyncInvalidate as any).mockClear();
});

describe('claimVoiceLease', () => {
  it('grants the lease when no prior row exists', async () => {
    sqlQueue.push([]);              // SELECT current
    sqlQueue.push([]);              // INSERT
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-A', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerId).toBe('tab-A');
    expect(out.lease.ownerKind).toBe('desktop');
    expect(out.lease.expiresAtMs).toBeGreaterThan(Date.now());
    // notifySyncInvalidate fires only on owner change. From-empty counts.
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });

  it('grants and refreshes for the same owner without notifying', async () => {
    sqlQueue.push([{ owner_id: 'tab-A', owner_kind: 'desktop', expires_at_ms: Date.now() + 5000 }]);
    sqlQueue.push([]); // INSERT (refresh)
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-A', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('refuses when a different owner holds a non-expired lease', async () => {
    sqlQueue.push([{ owner_id: 'tab-A', owner_kind: 'desktop', expires_at_ms: Date.now() + 5000 }]);
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-B', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(false);
    expect(out.lease.ownerId).toBe('tab-A');
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('takes the lease when the prior holder has expired', async () => {
    sqlQueue.push([{ owner_id: 'tab-A', owner_kind: 'desktop', expires_at_ms: Date.now() - 5000 }]);
    sqlQueue.push([]);
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'tab-B', ownerKind: 'desktop',
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerId).toBe('tab-B');
    expect(notifySyncInvalidate).toHaveBeenCalled();
  });

  it('force=true preempts an active different owner', async () => {
    sqlQueue.push([]); // INSERT (force skips the SELECT)
    const out = await claimVoiceLease({
      workspaceId: 'ws-1', ownerId: 'phone-1', ownerKind: 'mobile', force: true,
    });
    expect(out.granted).toBe(true);
    expect(out.lease.ownerKind).toBe('mobile');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });
});

describe('releaseVoiceLease', () => {
  it('deletes the row and notifies', async () => {
    sqlQueue.push([]);
    await releaseVoiceLease({ workspaceId: 'ws-1', ownerId: 'tab-A' });
    expect(sqlCalls[0].strings.join('?')).toContain('DELETE FROM harness_shared.voice_lease');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: 'ws-1' });
  });
});

describe('readVoiceLease', () => {
  it('returns null when no lease exists', async () => {
    sqlQueue.push([]);
    expect(await readVoiceLease('ws-x')).toBeNull();
  });

  it('returns the parsed lease when active', async () => {
    sqlQueue.push([{ owner_id: 'p1', owner_kind: 'mobile', expires_at_ms: Date.now() + 8000 }]);
    const lease = await readVoiceLease('ws-x');
    expect(lease).not.toBeNull();
    expect(lease!.ownerKind).toBe('mobile');
  });

  it('skips expired leases (filtered in WHERE)', async () => {
    sqlQueue.push([]);
    expect(await readVoiceLease('ws-x')).toBeNull();
    expect(sqlCalls[0].strings.join('?')).toContain('expires_at_ms');
  });
});


