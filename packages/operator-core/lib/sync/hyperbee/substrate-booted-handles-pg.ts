/**
 * substrate-booted-handles-pg.ts — the cross-SERVICE leg of the booted-handles
 * status broadcast (EI-19327550671915579, part 2 of EI-18735338283879820).
 *
 * `cluster-booted-handles-sync.ts` (EI-8816) pushes the substrate owner's
 * `listBootedHandles()` snapshot over `node:cluster` IPC — a mechanism confined
 * to ONE process tree (a primary + its own forked workers). Under the
 * dedicated-bg-host topology the true substrate owner is a SEPARATE systemd
 * service (`papercup-bg-host.service`); :3070/:3270 are each their own
 * unforked host, so they can never receive that broadcast — `node:cluster`
 * IPC only exists between a parent and a process it directly forked, and
 * bg-host never forked them. `resolveEffectiveBootedHandles` then honestly
 * (and, per EI-18735338283879820, correctly) reports `reachedSubstrateOwner:
 * false` forever, turning the substrate's own diagnostic into a permanent
 * blind spot rather than the transient one it was designed to be.
 *
 * This module closes that gap with the cross-service transport
 * EI-18735338283879820 deferred ("reuse-first, no new mechanism"): the
 * existing single-row-per-workspace `operator_state` PG pattern
 * (operator-state-pg.ts). Whichever process actually OWNS the substrate
 * (`isSubstrateOwnerProcess()`, evaluated per-beat — the SAME predicate that
 * gates the cluster broadcaster, so a non-owner can never poison this row
 * either, mirroring EI-18735338283879820's "never let a non-owner broadcast"
 * fix) periodically upserts its snapshot; any process — same host or not —
 * can read it back and apply the identical staleness gate
 * `resolveEffectiveBootedHandles` already uses for the cluster-IPC leg.
 *
 * Deliberately NOT wired into `resolveEffectiveBootedHandles` itself: that
 * function is documented (cluster-booted-handles-sync.ts's own file comment)
 * to stay a pure SYNCHRONOUS read so its two callers don't need an
 * async/shape change. A PG round-trip is inherently async, so callers that
 * want the cross-service fallback call `getPgBootedHandlesSnapshotFallback`
 * THEMSELVES, only when the fast sync path already reported
 * `reachedSubstrateOwner: false` — see dogfood-substrate-status.ts /
 * dogfood-substrate-health.ts / dev/dogfood_substrate_status.ts.
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';
import { isSubstrateOwnerProcess } from '../../background-workers';
import { listBootedHandles, type BootedHandleSummary } from './boot-all';
import { readOperatorState, writeOperatorState } from '../../operator-state-pg';
import type { RemoteBootedHandlesSnapshot } from './cluster-booted-handles-sync';

interface PgBootedHandlesPayload {
  handles: BootedHandleSummary[];
  sentAt: number;
}

export interface BootedHandlesPgPublisherHandle {
  stop(): void;
}

/**
 * SUBSTRATE-OWNER side: periodically upsert `listBootedHandles()` to the
 * cross-service PG row. Self-gates on real ownership EVERY beat (never once
 * at start) — mirrors `startBootedHandlesBroadcaster`'s `ownsSubstrate` gate
 * exactly, for the same reason: a punctual empty snapshot from a non-owner is
 * indistinguishable from the real owner reporting a genuinely-empty
 * substrate, and would manufacture a confident false zero instead of leaving
 * the honest blind spot (EI-18735338283879820).
 *
 * Safe to call unconditionally at boot on every host — a request-only host
 * simply never passes the per-beat gate, so it writes nothing.
 */
export function startBootedHandlesPgPublisher(opts: {
  intervalMs?: number;
  now?: () => number;
  /** Test seam / explicit override for "does this process own the substrate?". */
  ownsSubstrate?: boolean;
}): BootedHandlesPgPublisherHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const beat = (): void => {
    if (!(opts.ownsSubstrate ?? isSubstrateOwnerProcess())) return;
    void writeOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', {
      handles: listBootedHandles(),
      sentAt: now(),
    }).catch(() => {
      /* best-effort — a transient PG hiccup here must never crash boot; the
       * next beat retries, and a reader falling back to this row already
       * treats "row missing/stale" as an honest reachedSubstrateOwner:false. */
    });
  };
  beat();
  // D-004: 'must-sample' — the PRODUCER half of a liveness probe. Publishing only on
  // change is unsound here because ROW AGE is the signal: readers treat a row older than
  // DEFAULT_PG_SNAPSHOT_MAX_AGE_MS (3x this cadence) as "owner not reached", so an
  // unchanged-but-alive owner must keep re-stamping or it reads as dead. There is no
  // change event that carries "still alive, nothing changed".
  const timer = managedSetInterval('booted-handles-pg-publish', intervalMs, beat, {
    category: 'watchdog',
    classification: 'must-sample',
  });
  return {
    stop() {
      timer.stop();
    },
  };
}

/** How stale the cross-service PG row may be before a reader stops trusting
 *  it — matches DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS's 3x-interval
 *  generosity (3x this module's own 10s publish cadence: one missed beat is
 *  tolerated, a genuinely dead/wedged owner is not). */
const DEFAULT_PG_SNAPSHOT_MAX_AGE_MS = 30_000;

/**
 * READER side (any process, any host): read back the cross-service snapshot,
 * or `null` if there is none / it is stale. Shaped identically to
 * `RemoteBootedHandlesSnapshot` (cluster-booted-handles-sync.ts) so a caller
 * can feed it through the exact same staleness/trust logic as the in-process
 * cluster-IPC leg.
 *
 * Always a FRESH PG read (`{ fresh: true }`) — this is already the fallback
 * path (called only once the fast sync leg reported no answer), so serving a
 * cached value here would defeat the point.
 */
export async function getPgBootedHandlesSnapshotFallback(opts?: {
  maxAgeMs?: number;
  now?: () => number;
}): Promise<RemoteBootedHandlesSnapshot | null> {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PG_SNAPSHOT_MAX_AGE_MS;
  const now = opts?.now ?? (() => Date.now());
  let row: PgBootedHandlesPayload | null;
  try {
    row = await readOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', undefined, {
      fresh: true,
    });
  } catch {
    return null; // best-effort: a PG hiccup here degrades to the honest blind spot, never a throw.
  }
  if (!row || !Array.isArray(row.handles) || typeof row.sentAt !== 'number') return null;
  if (now() - row.sentAt > maxAgeMs) return null;
  return { handles: row.handles, receivedAt: row.sentAt };
}
