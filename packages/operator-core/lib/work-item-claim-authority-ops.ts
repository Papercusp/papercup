/**
 * work-item-claim-authority-ops — the AUTHORITY-side execution of work-item CLAIM ops
 * (decentralized-dispatch-scaling-2026-06-08 Phase 1, P-004 / D-002).
 *
 * When a Swarm resolves a REMOTE per-Hive authority for a work item and routes a claim
 * acquire/heartbeat/release there (acquireClaim → getWorkItemClaimAuthority().route →
 * the real Track-B router → PeerRpcTransport → the authority peer), the authority must
 * RUN that op against ITS local claim store, on the requesting Swarm's behalf (owner =
 * the remote peer's owner id, carried in the payload). This module registers the
 * handlers for the `work-item.claim.acquire` / `.heartbeat` / `.release` op kinds.
 *
 * Mirrors `plan-items/plan-item-claim-authority-ops.ts` exactly: bind a minimal
 * `WorkItemClaimCoordinator` SEAM rather than reach for the store directly, so the
 * handlers are fully testable with a fake coordinator and the receiving side stays
 * decoupled from the store's exact surface. The default coordinator is the real claim
 * store's `*Local` functions (the un-routed SQL leg).
 *
 * Distinct op kinds from the plan-item (`plan-item.claim.*`) + file-lock (`lock.*`)
 * handlers — registerAuthorityOp throws on a duplicate kind, so a clash surfaces at boot.
 */

import { registerAuthorityOp, registeredAuthorityOpKinds } from './authority';
import {
  acquireClaimLocal,
  heartbeatClaimLocal,
  releaseClaimLocal,
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type HeartbeatClaimParams,
  type HeartbeatResult,
  type ReleaseClaimParams,
} from './work-item-claims';

/**
 * The minimal claim-store surface the authority ops drive. The default binds the real
 * `*Local` SQL fns; tests inject a fake (or a real-PG-backed) coordinator.
 */
export interface WorkItemClaimCoordinator {
  acquire(opts: AcquireOpts): Promise<AcquireResult>;
  heartbeat(p: HeartbeatClaimParams): Promise<HeartbeatResult>;
  release(p: ReleaseClaimParams): Promise<boolean>;
}

/** The production coordinator: the un-routed claim-store SQL legs. */
export const DEFAULT_WORK_ITEM_CLAIM_COORDINATOR: WorkItemClaimCoordinator = {
  acquire: acquireClaimLocal,
  heartbeat: heartbeatClaimLocal,
  release: releaseClaimLocal,
};

function asAcquireOpts(payload: unknown): AcquireOpts {
  const p = payload as Partial<AcquireOpts>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.acquire: invalid payload (workspaceId, harnessSlug, workItemId, owner required)');
  }
  return p as AcquireOpts;
}

function asHeartbeatParams(payload: unknown): HeartbeatClaimParams {
  const p = payload as Partial<HeartbeatClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.heartbeat: invalid payload (workspaceId, harnessSlug, workItemId, claimId, owner required)');
  }
  return p as HeartbeatClaimParams;
}

function asReleaseParams(payload: unknown): ReleaseClaimParams {
  const p = payload as Partial<ReleaseClaimParams>;
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.harnessSlug !== 'string' ||
    typeof p.workItemId !== 'string' ||
    typeof p.claimId !== 'string' ||
    typeof p.owner !== 'string'
  ) {
    throw new Error('work-item.claim.release: invalid payload (workspaceId, harnessSlug, workItemId, claimId, owner required)');
  }
  return p as ReleaseClaimParams;
}

/**
 * Register the work-item claim authority op handlers against `coordinator`. Call ONCE at
 * boot (from the work_items tool barrel). Idempotent: a no-op if the kinds are already
 * registered (the global registry is reset between tests, so a re-run after a reset
 * re-registers cleanly). Each handler validates the payload, then runs the op locally on
 * THIS (the authority's) store.
 */
export function registerWorkItemClaimAuthorityOps(
  coordinator: WorkItemClaimCoordinator = DEFAULT_WORK_ITEM_CLAIM_COORDINATOR,
): void {
  if (registeredAuthorityOpKinds().includes(WORK_ITEM_CLAIM_OP_KINDS.acquire)) return;

  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.acquire, async (payload) =>
    coordinator.acquire(asAcquireOpts(payload)),
  );
  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.heartbeat, async (payload) =>
    coordinator.heartbeat(asHeartbeatParams(payload)),
  );
  registerAuthorityOp(WORK_ITEM_CLAIM_OP_KINDS.release, async (payload) =>
    coordinator.release(asReleaseParams(payload)),
  );
}
