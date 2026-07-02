/**
 * Unit tests for the file-lock authority op handlers (Phase 2). A fake
 * coordinator stands in for the su-lock-store; we drive the handlers through the
 * real handleAuthorityRpc dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerFileLockAuthorityOps,
  buildFileLockAuthorityHandlers,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
} from '../file-lock-authority-ops';
import { handleAuthorityRpc, __resetAuthorityOpsForTests } from '../authority-op-registry';
import type { LockEvent } from '../lock-event-stream';

afterEach(() => __resetAuthorityOpsForTests());

function fakeCoordinator(over: Partial<FileLockCoordinator> = {}): FileLockCoordinator {
  return {
    acquire: vi.fn(async () => ({ ok: true, lockId: 'lk-1', expiresTs: '2026-06-05T00:00:00Z' })),
    release: vi.fn(async () => ({ ok: true, released: ['apps/x.ts'] })),
    queue: vi.fn(async () => ({ held: [], waiters: [] })),
    ...over,
  };
}

describe('registerFileLockAuthorityOps', () => {
  it('dispatches lock.acquire to the coordinator with the requesting peer as owner', async () => {
    const coord = fakeCoordinator();
    registerFileLockAuthorityOps(coord);
    const res = await handleAuthorityRpc({
      harnessSlug: 'papercup',
      kind: FILE_LOCK_OP_KINDS.acquire,
      payload: { owner: 'peer-A', paths: ['apps/x.ts'], intent: 'edit', ttlSec: 600, coordinationDomain: '/repo' },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      ok: true,
      lockId: 'lk-1',
      expiresTs: '2026-06-05T00:00:00Z',
      // G-0 (P-033): every grant carries the sha-token stamp (fresh state here).
      shaToken: { requiredSha: null, unsyncedRisk: false },
    });
    expect(coord.acquire).toHaveBeenCalledWith({
      owner: 'peer-A',
      ownerLabel: undefined,
      paths: ['apps/x.ts'],
      intent: 'edit',
      ttlSec: 600,
      waitMaxSec: undefined,
      coordinationDomain: '/repo',
    });
  });

  it('defaults ttlSec to 1200 when omitted', async () => {
    const coord = fakeCoordinator();
    registerFileLockAuthorityOps(coord);
    await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { owner: 'A', paths: ['x'], intent: 'e', coordinationDomain: '/repo' } });
    expect((coord.acquire as ReturnType<typeof vi.fn>).mock.calls[0][0].ttlSec).toBe(1200);
  });

  it('lock.release + lock.queue dispatch to the coordinator', async () => {
    const coord = fakeCoordinator();
    registerFileLockAuthorityOps(coord);
    const rel = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.release', payload: { owner: 'A', lockId: 'lk-1', coordinationDomain: '/repo' } });
    expect(rel.result).toEqual({ ok: true, released: ['apps/x.ts'] });
    expect(coord.release).toHaveBeenCalledWith({ owner: 'A', lockId: 'lk-1', paths: undefined, allMine: undefined, coordinationDomain: '/repo' });
    const q = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.queue', payload: { owner: 'A', coordinationDomain: '/repo' } });
    expect(q.ok).toBe(true);
    expect(coord.queue).toHaveBeenCalledOnce();
  });

  it('returns a busy result (ok:false) faithfully — the authority denied the lock', async () => {
    const coord = fakeCoordinator({ acquire: vi.fn(async () => ({ ok: false, busy: [{ path: 'apps/x.ts', owner: 'peer-B' }] })) });
    registerFileLockAuthorityOps(coord);
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { owner: 'A', paths: ['apps/x.ts'], intent: 'e', coordinationDomain: '/repo' } });
    expect(res.ok).toBe(true); // the RPC itself succeeded
    expect(res.result).toEqual({ ok: false, busy: [{ path: 'apps/x.ts', owner: 'peer-B' }] });
  });

  it('an invalid payload → handler_error (not a crash)', async () => {
    registerFileLockAuthorityOps(fakeCoordinator());
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { owner: 'A' } /* no paths */ });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('handler_error');
    expect(res.message).toMatch(/invalid payload/);
  });
});

// ── P-015 lock-event emission (depth pass, su-7f3e0376) ──────────────────────
// The authority emits a lock-event on each grant/release so a NEW authority can
// reconstruct the live lock set INSTANTLY on failover. This is the module's whole
// reason to exist — and was untested. Drive buildFileLockAuthorityHandlers directly
// with an injected clock + emit capture.
describe('buildFileLockAuthorityHandlers — P-015 lock-event emission', () => {
  const FIXED_NOW = 1_700_000_000_000;
  function withCapture(over?: Partial<FileLockCoordinator>) {
    const events: LockEvent[] = [];
    const handlers = buildFileLockAuthorityHandlers(fakeCoordinator(over), {
      now: () => FIXED_NOW,
      emit: (e) => void events.push(e),
    });
    return { handlers, events };
  }

  it('emits one acquire lock-event per granted path on success (scope/owner/ts stamped)', async () => {
    const { handlers, events } = withCapture({
      acquire: vi.fn(async () => ({ ok: true, lockId: 'lk', expiresTs: '2026-06-05T00:00:00Z' })),
    });
    await handlers[FILE_LOCK_OP_KINDS.acquire](
      { owner: 'peer-A', paths: ['a.ts', 'b.ts'], intent: 'edit', ttlSec: 600, coordinationDomain: '/repo' },
      'scope-h',
    );
    expect(events.map((e) => `${e.kind}:${e.path}:${e.owner}:${e.scope}`)).toEqual([
      'acquire:a.ts:peer-A:scope-h',
      'acquire:b.ts:peer-A:scope-h',
    ]);
    expect(events[0].expiresAtMs).toBe(Date.parse('2026-06-05T00:00:00Z')); // from the store's ISO
    expect(events.every((e) => e.ts === FIXED_NOW)).toBe(true);
  });

  it('expiresAtMs falls back to now + ttlSec*1000 when the store returns no expiresTs', async () => {
    const { handlers, events } = withCapture({ acquire: vi.fn(async () => ({ ok: true, lockId: 'lk' })) });
    await handlers[FILE_LOCK_OP_KINDS.acquire](
      { owner: 'A', paths: ['a.ts'], intent: 'e', ttlSec: 30, coordinationDomain: '/repo' },
      'h',
    );
    expect(events[0].expiresAtMs).toBe(FIXED_NOW + 30_000);
  });

  it('emits NOTHING when the acquire is DENIED (ok:false) — never records a lock it did not grant', async () => {
    const { handlers, events } = withCapture({
      acquire: vi.fn(async () => ({ ok: false, busy: [{ path: 'a.ts', owner: 'peer-B' }] })),
    });
    await handlers[FILE_LOCK_OP_KINDS.acquire](
      { owner: 'A', paths: ['a.ts'], intent: 'e', ttlSec: 600, coordinationDomain: '/repo' },
      'h',
    );
    expect(events).toEqual([]);
  });

  it('emits a release event only for the paths the store ACTUALLY released', async () => {
    const { handlers, events } = withCapture({ release: vi.fn(async () => ({ ok: true, released: ['a.ts', 'c.ts'] })) });
    await handlers[FILE_LOCK_OP_KINDS.release]({ owner: 'A', allMine: true, coordinationDomain: '/repo' }, 'h');
    expect(events.map((e) => `${e.kind}:${e.path}`)).toEqual(['release:a.ts', 'release:c.ts']);
    expect(events.every((e) => e.owner === 'A' && e.scope === 'h' && e.ts === FIXED_NOW)).toBe(true);
  });

  it('emits nothing on release when ok but the store reports no released paths', async () => {
    const { handlers, events } = withCapture({ release: vi.fn(async () => ({ ok: true })) });
    await handlers[FILE_LOCK_OP_KINDS.release]({ owner: 'A', allMine: true, coordinationDomain: '/repo' }, 'h');
    expect(events).toEqual([]);
  });

  it('release + queue reject an invalid payload (missing owner / coordinationDomain)', async () => {
    const { handlers } = withCapture();
    await expect(handlers[FILE_LOCK_OP_KINDS.release]({ owner: 'A' }, 'h')).rejects.toThrow(/invalid payload/);
    await expect(handlers[FILE_LOCK_OP_KINDS.queue]({ coordinationDomain: '/repo' }, 'h')).rejects.toThrow(/invalid payload/);
  });
});
