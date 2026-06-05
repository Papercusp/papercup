/**
 * resource-lock-guard — the requiresLock enforcement primitive (Phase 8).
 *
 * D-016 (refines D-011): the `enforced` rung is realized as a handler HOF,
 * not a dispatcher interceptor. Reason: `defineTool` lives in the borrowable,
 * domain-free `libs/generic/tooldef` lib; threading a locks-domain
 * `requiresLock` field through the generic dispatcher would couple it to the
 * locks domain. A handler HOF gives the SAME guarantee — the tool body cannot
 * run unless the lock is held — while keeping all locks knowledge operator-
 * side. A fully-declarative dispatcher seam can be a later follow-up.
 *
 *   guardResource(spec, run)  — testable core: acquire (drain for exclusive)
 *                               → run() ONLY if acquired → release after
 *                               (+ drain-start / back-up broadcasts).
 *   withResourceLock(spec, h) — wraps a role-gated tool handler; resolves
 *                               identity from ctx and delegates to guardResource.
 */

import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { readIdentity, type IdentityCtx } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import {
  tryAcquireResource,
  tryReleaseResource,
  assertResourceFenceCurrent,
  getTxPool,
  type ResourceMode,
  type ResourceHolder,
  type FenceCheck,
} from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
import { broadcastResourceDrainStart, broadcastResourceBackUp } from './resource-broadcast';

const DEFAULT_TTL_SEC = 1200;

export interface GuardSpec {
  coordinationDomain: string;
  ownerId: string;
  ownerLabel: string | null;
  /** Coord identity for the drain-start / back-up broadcasts. */
  coordIdentity: AgentIdentity;
  resource: string;
  mode: ResourceMode;
  /** Exclusive only: drain wait budget (sec). Default 0 → fail if shared held. */
  maxDrainSec?: number;
  ttlSec?: number;
  reason?: string;
}

export type GuardOutcome<T> =
  | { acquired: true; result: T; lock_id: string }
  | { acquired: false; reason: string; holders: ResourceHolder[] };

/**
 * The fencing handle (D-001) handed to `run()`. `assertCurrent()` re-verifies,
 * against PG, that this holder STILL holds the effective exclusive at this fence
 * — the destructive action calls it immediately before mutating so a
 * paused/zombie holder whose lease lapsed (and was re-granted) is rejected
 * instead of corrupting shared state. For a shared lock it is a no-op (fencing
 * is exclusive-only; shared is efficiency-class, git-backstopped).
 */
export interface FenceToken {
  resource: string;
  coordinationDomain: string;
  lockId: string;
  mode: ResourceMode;
  /** Monotonic fence; non-zero only for an effective exclusive. */
  seq: number;
  assertCurrent: () => Promise<FenceCheck>;
}

/**
 * Acquire `resource`, run `run(fence)` only if acquired, release in a finally.
 * The lock is held for the entire duration of `run()` and released after —
 * so the body genuinely cannot run without the lock. `run` receives a
 * {@link FenceToken} it can re-check before any destructive step (D-001).
 */
export async function guardResource<T>(
  spec: GuardSpec,
  run: (fence: FenceToken) => Promise<T>,
): Promise<GuardOutcome<T>> {
  const { coordinationDomain: cd, ownerId, ownerLabel, coordIdentity, resource, mode } = spec;
  const ttlSec = spec.ttlSec ?? DEFAULT_TTL_SEC;
  const reason = spec.reason ?? '';

  let lockId: string;
  let fenceSeq = 0;
  if (mode === 'shared') {
    const r = await inWorkspaceTxn(cd, ownerId, (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: cd,
        resource,
        mode: 'shared',
        owner: ownerId,
        ownerLabel,
        reason,
        ttlSec,
      }),
    );
    if (!r.ok) return { acquired: false, reason: r.reason, holders: r.holders };
    lockId = r.lock_id;
    fenceSeq = r.fence_seq;
  } else {
    const r = await acquireResourceExclusiveWithWait({
      coordinationDomain: cd,
      owner: ownerId,
      ownerLabel,
      resource,
      reason,
      ttlSec,
      maxWaitSec: spec.maxDrainSec ?? 0,
      onDrainStart: (holders) =>
        broadcastResourceDrainStart({ source: coordIdentity, resource, holders, reason }),
    });
    if (r.ok) {
      if (r.status !== 'held') {
        // maxDrainSec was 0 and shared holders remain — not effective.
        return { acquired: false, reason: 'draining', holders: r.holders };
      }
      lockId = r.lock_id;
      fenceSeq = r.fence_seq;
    } else {
      return { acquired: false, reason: r.reason, holders: r.holders };
    }
  }

  const capturedLockId = lockId;
  const fence: FenceToken = {
    resource,
    coordinationDomain: cd,
    lockId: capturedLockId,
    mode,
    seq: fenceSeq,
    assertCurrent: () =>
      mode === 'exclusive'
        ? assertResourceFenceCurrent(getTxPool(), {
            coordinationDomain: cd,
            resource,
            lockId: capturedLockId,
            fenceSeq,
          })
        : Promise.resolve({ current: true, live_fence_seq: 0 } as FenceCheck),
  };

  try {
    const result = await run(fence);
    return { acquired: true, result, lock_id: lockId };
  } finally {
    const released = await inWorkspaceTxn(cd, ownerId, (tx) =>
      tryReleaseResource(tx, { coordinationDomain: cd, owner: ownerId, lockId }),
    ).catch(() => null);
    if (mode === 'exclusive') {
      // A4: notify just the waiters on this resource, not ['*'].
      await broadcastResourceBackUp({
        source: coordIdentity,
        resource,
        waiters: released?.waiters[resource] ?? [],
      }).catch(() => {});
    }
  }
}

export interface RequiresLock {
  resource: string;
  mode: ResourceMode;
  /** Exclusive only: drain wait budget (sec). */
  maxDrainSec?: number;
  ttlSec?: number;
  reason?: string;
}

type ToolResultLike = { content: Array<{ type: 'text'; text: string }> };

/**
 * Wrap a role-gated tool handler so its body runs only while the declared
 * resource lock is held. On failure to acquire (busy / draining / timeout),
 * returns a structured `ok:false` ToolResult WITHOUT running the body — this
 * is the `enforced` behaviour for any action expressed as a tool.
 */
export function withResourceLock<A, C extends IdentityCtx>(
  spec: RequiresLock,
  handler: (args: A, ctx: C) => Promise<ToolResultLike> | ToolResultLike,
): (args: A, ctx: C) => Promise<ToolResultLike> {
  return async (args: A, ctx: C): Promise<ToolResultLike> => {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const outcome = await guardResource<ToolResultLike>(
      {
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: spec.resource,
        mode: spec.mode,
        maxDrainSec: spec.maxDrainSec,
        ttlSec: spec.ttlSec,
        reason: spec.reason,
      },
      async () => handler(args, ctx),
    );
    if (outcome.acquired) return outcome.result;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            reason: `resource_${outcome.reason}`,
            resource: spec.resource,
            holders: outcome.holders.map((h) => ({
              owner: h.owner,
              owner_label: h.owner_label,
              mode: h.mode,
              status: h.status,
            })),
          }),
        },
      ],
    };
  };
}
