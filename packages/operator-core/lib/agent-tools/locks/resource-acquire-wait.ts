/**
 * resource-acquire-wait — the exclusive drain wait loop (Phase 4, P-006).
 *
 * Acquires a named resource in `exclusive` mode and, while live shared
 * holders remain (status 'draining'), blocks until the drain completes
 * (resource_grant_cascade flips it to 'held' and NOTIFYs) or max_drain_sec
 * elapses. Mirrors locks:acquire's wait protocol:
 *
 *   1. subscribeWorkspace (LISTEN ch_coord_<domain>) BEFORE the acquire,
 *      so a drain-completion NOTIFY for our exclusive can't be lost.
 *   2. tryAcquireResource(exclusive). held → return; draining → wait.
 *   3. await NOTIFY with a WAIT_CEILING_MS ceiling per iteration; on each
 *      wake, pokeResource (sweep expired shared + cascade) so a TTL-lapsed
 *      holder still completes the drain, then re-read status.
 *   4. status held → granted; deadline passed → drain_timeout (the
 *      exclusive row is LEFT in place — the writer still wants in; it
 *      TTL-expires or the caller releases — so the caller can force-
 *      proceed or escalate, per P-006/D-005).
 *
 * The drain-START broadcast that tells shared holders to release is Phase 3
 * (P-009, fireNotifications); this loop is correct without it (drain
 * completes whenever holders release or expire), the broadcast just
 * accelerates it.
 */

import {
  getTxPool,
  pokeResource,
  readResourceLockStatus,
  readResourceQueue,
  tryAcquireResource,
  type ResourceHolder,
} from './su-lock-store';
import { inWorkspaceTxn } from './in-workspace-txn';
import { subscribeWorkspace } from './workspace-listener';

/** Per-iteration ceiling: re-poll status at least this often even if the
 *  LISTEN connection silently dropped a wake. */
const WAIT_CEILING_MS = 5_000;

type ConflictReason =
  | 'unknown_resource'
  | 'exclusive_pending'
  | 'holds_shared'
  | 'held_exclusive'
  | 'at_capacity'; // D-008: only on the shared path, but the store's reason union includes it.

export interface ExclusiveWaitParams {
  coordinationDomain: string;
  owner: string;
  ownerLabel: string | null;
  resource: string;
  reason: string;
  ttlSec: number;
  /** 0 = don't wait (return draining immediately); >0 = drain up to N sec. */
  maxWaitSec: number;
  /** Optional progress callback fired each iteration while still draining. */
  onTick?: (info: { waited_sec: number; holders: ResourceHolder[] }) => void;
  /** Fired once when the exclusive enters 'draining' (shared holders present),
   *  with those holders — the hook the tool uses to broadcast drain-start. */
  onDrainStart?: (holders: ResourceHolder[]) => void | Promise<void>;
}

export type ExclusiveWaitResult =
  | {
      ok: true;
      status: 'held';
      lock_id: string;
      waited_sec: number;
      shared_holders_at_start: ResourceHolder[];
      /** Monotonic fencing token of the granted exclusive (D-001). */
      fence_seq: number;
    }
  | { ok: true; status: 'draining'; lock_id: string; holders: ResourceHolder[] } // maxWaitSec === 0
  | { ok: false; reason: ConflictReason; holders: ResourceHolder[] }
  | { ok: false; reason: 'drain_timeout'; lock_id: string; holders: ResourceHolder[]; waited_sec: number };

const elapsedSec = (since: number) => Math.floor((Date.now() - since) / 1000);

export async function acquireResourceExclusiveWithWait(
  params: ExclusiveWaitParams,
): Promise<ExclusiveWaitResult> {
  const { coordinationDomain: cd, owner, ownerLabel, resource, reason, ttlSec, maxWaitSec, onTick, onDrainStart } = params;
  const startedAt = Date.now();

  const doAcquire = () =>
    inWorkspaceTxn(cd, owner, (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: cd,
        resource,
        mode: 'exclusive',
        owner,
        ownerLabel,
        reason,
        ttlSec,
      }),
    );

  // No-wait path: acquire once and report whatever we get.
  if (maxWaitSec <= 0) {
    const r = await doAcquire();
    if (!r.ok) return { ok: false, reason: r.reason, holders: r.holders };
    if (r.status === 'held') {
      return { ok: true, status: 'held', lock_id: r.lock_id, waited_sec: 0, shared_holders_at_start: r.shared_holders, fence_seq: r.fence_seq };
    }
    return { ok: true, status: 'draining', lock_id: r.lock_id, holders: r.shared_holders };
  }

  let lockId: string | null = null;
  let wakeResolve: (() => void) | null = null;
  let pendingWake = false;
  let unsubscribe: (() => Promise<void>) | null = null;

  // Step 1: subscribe BEFORE the acquire. We don't know lock_id yet — the
  // callback matches it once it's assigned below.
  try {
    unsubscribe = await subscribeWorkspace(cd, (tid) => {
      if (lockId && tid === lockId) {
        pendingWake = true;
        if (wakeResolve) {
          const r = wakeResolve;
          wakeResolve = null;
          r();
        }
      }
    });
  } catch {
    // LISTEN-pool saturated (too many active workspaces). Fall back to a
    // single no-wait acquire so the caller still gets a structured result.
    const r = await doAcquire();
    if (!r.ok) return { ok: false, reason: r.reason, holders: r.holders };
    if (r.status === 'held') {
      return { ok: true, status: 'held', lock_id: r.lock_id, waited_sec: 0, shared_holders_at_start: r.shared_holders, fence_seq: r.fence_seq };
    }
    return { ok: true, status: 'draining', lock_id: r.lock_id, holders: r.shared_holders };
  }

  try {
    const acquired = await doAcquire();
    if (!acquired.ok) {
      return { ok: false, reason: acquired.reason, holders: acquired.holders };
    }
    if (acquired.status === 'held') {
      return {
        ok: true,
        status: 'held',
        lock_id: acquired.lock_id,
        waited_sec: 0,
        shared_holders_at_start: acquired.shared_holders,
        fence_seq: acquired.fence_seq,
      };
    }

    // Draining — arm the callback match + wait.
    lockId = acquired.lock_id;
    const sharedAtStart = acquired.shared_holders;
    const deadline = startedAt + maxWaitSec * 1000;

    // Drain-start hook (P-009) — let the caller broadcast "release please".
    if (onDrainStart) {
      try {
        await onDrainStart(sharedAtStart);
      } catch {
        // best-effort — a broadcast failure must never break the drain wait.
      }
    }

    // Re-check once: drain may have completed between our acquire commit
    // and arming the wake (a shared release racing our INSERT).
    const recheck = await readResourceLockStatus(getTxPool(), lockId);
    if (recheck.status === 'held') {
      return { ok: true, status: 'held', lock_id: lockId, waited_sec: elapsedSec(startedAt), shared_holders_at_start: sharedAtStart, fence_seq: recheck.fence_seq ?? 0 };
    }

    while (Date.now() < deadline) {
      if (pendingWake) {
        pendingWake = false;
      } else {
        const ceiling = Math.min(deadline - Date.now(), WAIT_CEILING_MS);
        let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
        await new Promise<void>((resolve) => {
          wakeResolve = resolve;
          ceilingTimer = setTimeout(() => {
            if (wakeResolve) {
              const r = wakeResolve;
              wakeResolve = null;
              r();
            }
          }, ceiling);
        });
        if (ceilingTimer !== null) clearTimeout(ceilingTimer);
        wakeResolve = null;
      }

      // Nudge: a TTL-lapsed shared holder fires no cascade on its own.
      await inWorkspaceTxn(cd, owner, (tx) => pokeResource(tx, cd));

      const st = await readResourceLockStatus(getTxPool(), lockId);
      if (st.status === 'held') {
        return { ok: true, status: 'held', lock_id: lockId, waited_sec: elapsedSec(startedAt), shared_holders_at_start: sharedAtStart, fence_seq: st.fence_seq ?? 0 };
      }
      if (st.status === 'missing') break; // our exclusive vanished (expired / released)

      if (onTick) {
        const q = await readResourceQueue(getTxPool(), { coordinationDomain: cd, resource });
        onTick({ waited_sec: elapsedSec(startedAt), holders: q.holders });
      }
    }

    const q = await readResourceQueue(getTxPool(), { coordinationDomain: cd, resource });
    return { ok: false, reason: 'drain_timeout', lock_id: lockId, holders: q.holders, waited_sec: elapsedSec(startedAt) };
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => undefined);
  }
}
