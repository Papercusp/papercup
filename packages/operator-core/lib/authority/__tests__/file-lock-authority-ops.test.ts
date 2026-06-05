/**
 * Unit tests for the file-lock authority op handlers (Phase 2). A fake
 * coordinator stands in for the su-lock-store; we drive the handlers through the
 * real handleAuthorityRpc dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerFileLockAuthorityOps,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
} from '../file-lock-authority-ops';
import { handleAuthorityRpc, __resetAuthorityOpsForTests } from '../authority-op-registry';

afterEach(() => __resetAuthorityOpsForTests());

function fakeCoordinator(over: Partial<FileLockCoordinator> = {}): FileLockCoordinator {
  return {
    acquire: vi.fn(async () => ({ ok: true, lockId: 'lk-1', expiresTs: '2026-06-05T00:00:00Z' })),
    release: vi.fn(async () => ({ ok: true, released: 1 })),
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
      payload: { owner: 'peer-A', paths: ['apps/x.ts'], intent: 'edit', ttlSec: 600 },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ ok: true, lockId: 'lk-1', expiresTs: '2026-06-05T00:00:00Z' });
    expect(coord.acquire).toHaveBeenCalledWith({
      owner: 'peer-A',
      ownerLabel: undefined,
      paths: ['apps/x.ts'],
      intent: 'edit',
      ttlSec: 600,
      waitMaxSec: undefined,
    });
  });

  it('defaults ttlSec to 1200 when omitted', async () => {
    const coord = fakeCoordinator();
    registerFileLockAuthorityOps(coord);
    await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { owner: 'A', paths: ['x'], intent: 'e' } });
    expect((coord.acquire as ReturnType<typeof vi.fn>).mock.calls[0][0].ttlSec).toBe(1200);
  });

  it('lock.release + lock.queue dispatch to the coordinator', async () => {
    const coord = fakeCoordinator();
    registerFileLockAuthorityOps(coord);
    const rel = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.release', payload: { owner: 'A', lockId: 'lk-1' } });
    expect(rel.result).toEqual({ ok: true, released: 1 });
    expect(coord.release).toHaveBeenCalledWith({ owner: 'A', lockId: 'lk-1', paths: undefined, allMine: undefined });
    const q = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.queue', payload: { owner: 'A' } });
    expect(q.ok).toBe(true);
    expect(coord.queue).toHaveBeenCalledOnce();
  });

  it('returns a busy result (ok:false) faithfully — the authority denied the lock', async () => {
    const coord = fakeCoordinator({ acquire: vi.fn(async () => ({ ok: false, busy: [{ path: 'apps/x.ts', owner: 'peer-B' }] })) });
    registerFileLockAuthorityOps(coord);
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { owner: 'A', paths: ['apps/x.ts'], intent: 'e' } });
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
