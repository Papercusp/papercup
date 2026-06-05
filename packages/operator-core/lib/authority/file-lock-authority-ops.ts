/**
 * file-lock-authority-ops — the AUTHORITY-side execution of file-claim lock ops
 * (Phase 2 of distributed-coordination-shared-harness-2026-06-04).
 *
 * When a peer resolves a REMOTE authority for a harness and routes a file-lock
 * acquire/release/queue there (routeFileLockOp → routeToAuthority →
 * PeerRpcTransport → POST /api/authority/rpc → handleAuthorityRpc), the authority
 * must RUN that op against ITS local lock store, on the requesting peer's behalf
 * (owner = the remote peer's owner id, carried in the payload). This module
 * registers the handlers for the `lock.acquire` / `lock.release` / `lock.queue`
 * op kinds.
 *
 * It binds to a minimal `FileLockCoordinator` SEAM rather than the concrete
 * su-lock-store, for two reasons: (1) it decouples from the locks package's exact
 * surface (which is mid-extraction to @papercusp/locks-core), and (2) it makes
 * the handlers fully testable with a fake coordinator. The operator adapts the
 * real su-lock-store (@papercusp/locks SuLocksCoordinator) to this seam at boot:
 *
 *   registerFileLockAuthorityOps(adaptSuLockStore());  // boot wiring
 *
 * The cross-machine model: peer A (non-authority) wants lock X → RPCs authority B
 * → B's store records X held by A → A's later release RPCs B again. B's single
 * store is the serialization point (proven by two-instance-authority.integration).
 */

import { registerAuthorityOp } from './authority-op-registry';

/** Acquire a file-claim lock on behalf of `owner` (the requesting peer). */
export interface FileLockAcquireParams {
  owner: string;
  ownerLabel?: string;
  paths: string[];
  intent: string;
  ttlSec: number;
  /** Optional bounded wait, mirroring locks:acquire. */
  waitMaxSec?: number;
}
export interface FileLockReleaseParams {
  owner: string;
  lockId?: string;
  paths?: string[];
  allMine?: boolean;
}
export interface FileLockQueueParams {
  owner: string;
  paths?: string[];
}

export interface FileLockAcquireResult {
  ok: boolean;
  lockId?: string;
  expiresTs?: string;
  /** paths that were busy when ok=false. */
  busy?: Array<{ path: string; owner: string }>;
}

/** The minimal lock-store surface the authority ops drive. The operator adapts
 *  the real su-lock-store to this at boot; tests inject a fake. */
export interface FileLockCoordinator {
  acquire(p: FileLockAcquireParams): Promise<FileLockAcquireResult>;
  release(p: FileLockReleaseParams): Promise<{ ok: boolean; released?: number }>;
  queue(p: FileLockQueueParams): Promise<unknown>;
}

/** The op kinds this module registers — exported so callers/tests can reference
 *  them without string literals (and the claim layer can avoid collisions). */
export const FILE_LOCK_OP_KINDS = {
  acquire: 'lock.acquire',
  release: 'lock.release',
  queue: 'lock.queue',
} as const;

/**
 * Register the file-lock authority op handlers against `coordinator`. Call ONCE
 * at boot. Each handler validates the payload shape, then runs the op locally.
 */
export function registerFileLockAuthorityOps(coordinator: FileLockCoordinator): void {
  registerAuthorityOp(FILE_LOCK_OP_KINDS.acquire, async (payload) => {
    const p = payload as Partial<FileLockAcquireParams>;
    if (!p || typeof p.owner !== 'string' || !Array.isArray(p.paths) || typeof p.intent !== 'string') {
      throw new Error('lock.acquire: invalid payload (owner, paths[], intent required)');
    }
    return coordinator.acquire({
      owner: p.owner,
      ownerLabel: p.ownerLabel,
      paths: p.paths,
      intent: p.intent,
      ttlSec: typeof p.ttlSec === 'number' ? p.ttlSec : 1200,
      waitMaxSec: p.waitMaxSec,
    });
  });

  registerAuthorityOp(FILE_LOCK_OP_KINDS.release, async (payload) => {
    const p = payload as Partial<FileLockReleaseParams>;
    if (!p || typeof p.owner !== 'string') {
      throw new Error('lock.release: invalid payload (owner required)');
    }
    return coordinator.release({ owner: p.owner, lockId: p.lockId, paths: p.paths, allMine: p.allMine });
  });

  registerAuthorityOp(FILE_LOCK_OP_KINDS.queue, async (payload) => {
    const p = payload as Partial<FileLockQueueParams>;
    if (!p || typeof p.owner !== 'string') {
      throw new Error('lock.queue: invalid payload (owner required)');
    }
    return coordinator.queue({ owner: p.owner, paths: p.paths });
  });
}
