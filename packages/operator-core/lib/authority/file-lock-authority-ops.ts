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
  /**
   * The requester's coordination domain (repo realpath). Threaded on the wire so the
   * AUTHORITY runs the op against the lock store for the SAME physical repo — the lock
   * namespace is a property of the file on disk, and the authority + requester edit the
   * same shared checkout (different machines, same realpath). Required on the remote leg;
   * the authority builds its store binding from it.
   */
  coordinationDomain: string;
}
export interface FileLockReleaseParams {
  owner: string;
  lockId?: string;
  paths?: string[];
  allMine?: boolean;
  /** See FileLockAcquireParams.coordinationDomain. */
  coordinationDomain: string;
}
export interface FileLockQueueParams {
  owner: string;
  paths?: string[];
  /** See FileLockAcquireParams.coordinationDomain. */
  coordinationDomain: string;
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
  /** `released` is the list of paths actually released — carried (not a count) so the
   *  requester's routed-release response matches the local-release shape exactly. */
  release(p: FileLockReleaseParams): Promise<{ ok: boolean; released?: string[] }>;
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
    if (
      !p ||
      typeof p.owner !== 'string' ||
      !Array.isArray(p.paths) ||
      typeof p.intent !== 'string' ||
      typeof p.coordinationDomain !== 'string'
    ) {
      throw new Error('lock.acquire: invalid payload (owner, paths[], intent, coordinationDomain required)');
    }
    return coordinator.acquire({
      owner: p.owner,
      ownerLabel: p.ownerLabel,
      paths: p.paths,
      intent: p.intent,
      ttlSec: typeof p.ttlSec === 'number' ? p.ttlSec : 1200,
      waitMaxSec: p.waitMaxSec,
      coordinationDomain: p.coordinationDomain,
    });
  });

  registerAuthorityOp(FILE_LOCK_OP_KINDS.release, async (payload) => {
    const p = payload as Partial<FileLockReleaseParams>;
    if (!p || typeof p.owner !== 'string' || typeof p.coordinationDomain !== 'string') {
      throw new Error('lock.release: invalid payload (owner, coordinationDomain required)');
    }
    return coordinator.release({
      owner: p.owner,
      lockId: p.lockId,
      paths: p.paths,
      allMine: p.allMine,
      coordinationDomain: p.coordinationDomain,
    });
  });

  registerAuthorityOp(FILE_LOCK_OP_KINDS.queue, async (payload) => {
    const p = payload as Partial<FileLockQueueParams>;
    if (!p || typeof p.owner !== 'string' || typeof p.coordinationDomain !== 'string') {
      throw new Error('lock.queue: invalid payload (owner, coordinationDomain required)');
    }
    return coordinator.queue({ owner: p.owner, paths: p.paths, coordinationDomain: p.coordinationDomain });
  });
}
