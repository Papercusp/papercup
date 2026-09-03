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
import {
  listBootedHandles,
  listRelocatedBootedHandles,
  type BootedHandleSummary,
} from './boot-all';
import type { BootedAnnounceIdentity } from './boot';
import { readOperatorState, writeOperatorState } from '../../operator-state-pg';
import {
  collectSubstrateHealthInputs,
  isCompleteHealthInputs,
  type RemoteBootedHandlesSnapshot,
  type SubstrateHealthInputsBundle,
} from './cluster-booted-handles-sync';
import { resolveSubstrateSocketPath } from './substrate-socket-path';
import { isAbsolute } from 'node:path';

interface PgRelocatedSidecarAdvertisement {
  /** Absolute, machine-local JSON-RPC socket owned by the substrate process. */
  socketPath: string;
  /** Exact handles that are relocated behind this socket. */
  handles: BootedHandleSummary[];
}

interface PgBootedHandlesPayload {
  handles: BootedHandleSummary[];
  sentAt: number;
  /**
   * EI-20575137548097507: the owner's health-input registries, published
   * ALONGSIDE the handle list so a non-owner reader can actually ASSESS the
   * harnesses this row tells it about.
   *
   * Before this, every leg of the fallback chain (local map → cluster IPC → this
   * PG row) carried only the handle LIST, while the liveness/fork detectors
   * stayed module-scope state in the owner process. A non-owner therefore
   * reported ever more harnesses it was no better able to assess, and the
   * unmeasured verdict rendered as `healthy` / "no issues detected" — five
   * filed instances of one defect. Publishing it here rather than adding a
   * second registry follows the same reasoning as the `sidecar` field above,
   * and covers BOTH non-owner topologies (cluster worker and cross-service
   * request-only host) with one mechanism.
   *
   * Optional for backward compatibility with rows written by an older owner: a
   * reader that finds it absent must treat health as UNOBSERVED, never healthy.
   * The same applies to a row written by the FIRST pass of this fix, which
   * carried a bare `replicationLiveness` and no fork/log-stat state — that row
   * is deliberately not upgraded in place, because a reader cannot honestly
   * claim to have observed inputs the row never carried.
   */
  healthInputs?: SubstrateHealthInputsBundle;
  /**
   * Optional for backward compatibility with pre-EI-20438405483051865 rows and
   * absent for an in-process substrate owner.  This extends the existing
   * cross-service owner advertisement instead of inventing a second registry.
   */
  sidecar?: PgRelocatedSidecarAdvertisement;
}

export interface PgRelocatedHarnessEndpoint {
  socketPath: string;
  advertisedAt: number;
}

/**
 * What the substrate owner says about ONE pot's swarm identity, for a reader in
 * another process (WI-2142873).
 *
 * The three states are deliberately distinct, because collapsing any two of
 * them is what caused the defect this exists to fix:
 *
 * - `null` (no result)  — UNKNOWN. No fresh advertisement; we learned nothing.
 * - `{ booted: false }` — the owner holds NO handle for this pot. Nothing
 *   serves it, so a gh-login fallback is the honest best effort.
 * - `{ booted: true, identity }` — a handle exists. `identity` is the device
 *   peers file our socket under; a `null` identity means the owner is running
 *   pre-WI-2142873 code and could not tell us, which is NOT permission to sign
 *   as some other device.
 */
export interface PgBootedHarnessIdentity {
  booted: boolean;
  identity: BootedAnnounceIdentity | null;
  advertisedAt: number;
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
  const beat = (): void | Promise<void> => {
    if (!(opts.ownsSubstrate ?? isSubstrateOwnerProcess())) return;
    const handles = listBootedHandles();
    const relocated = listRelocatedBootedHandles();
    const payload: PgBootedHandlesPayload = {
      handles,
      sentAt: now(),
      // EI-20575137548097507: publish what a reader needs to ASSESS these
      // handles, not just enumerate them.
      healthInputs: collectSubstrateHealthInputs(),
      ...(relocated.length > 0
        ? {
            sidecar: {
              socketPath: resolveSubstrateSocketPath(),
              handles: relocated,
            },
          }
        : {}),
    };
    // Return the write Promise to managedSetInterval. Swallowing it here made
    // the timer look healthy (`lastError:null`) while every PG write failed —
    // exactly the observability gap that prolonged EI-20952729544817284. The
    // managed timer records/logs a rejection and still retries next interval.
    return writeOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', payload);
  };
  // Preserve the publisher's existing synchronous first-attempt semantics:
  // writeOperatorState is invoked before this function returns. This attempt
  // is outside the managed interval, so contain + name its failure explicitly;
  // subsequent failures are visible through the timer's lastError field.
  const initialBeat = beat();
  if (initialBeat) {
    void initialBeat.catch((error: unknown) => {
      console.warn(
        `[booted-handles-pg] initial publish failed; next interval retries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
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

async function readFreshPgBootedHandlesPayload(opts?: {
  maxAgeMs?: number;
  now?: () => number;
}): Promise<PgBootedHandlesPayload | null> {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PG_SNAPSHOT_MAX_AGE_MS;
  const now = opts?.now ?? (() => Date.now());
  let row: PgBootedHandlesPayload | null;
  try {
    row = await readOperatorState<PgBootedHandlesPayload>('substrate_booted_handles_status', undefined, {
      fresh: true,
    });
  } catch {
    return null;
  }
  if (!row || !Array.isArray(row.handles) || typeof row.sentAt !== 'number') return null;
  if (now() - row.sentAt > maxAgeMs) return null;
  return row;
}

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
  const row = await readFreshPgBootedHandlesPayload(opts);
  if (!row) return null;
  return {
    handles: row.handles,
    receivedAt: row.sentAt,
    // EI-20575137548097507: absent on rows written by a pre-fix owner — passed
    // through as `undefined` so the reader reports health UNOBSERVED rather
    // than manufacturing a healthy verdict from a missing field. A partial
    // bundle is rejected for the same reason (isCompleteHealthInputs).
    ...(isCompleteHealthInputs(row.healthInputs)
      ? { healthInputs: row.healthInputs }
      : {}),
  };
}

/**
 * Resolve the true substrate owner's machine-local sidecar socket for one
 * exact relocated harness.
 *
 * This is deliberately stricter than the diagnostic snapshot reader: the row
 * must be fresh, the path must be absolute, and the requested `(workspace,
 * harness)` must appear in the sidecar-specific handle list.  The caller still
 * performs an existing-only `substrate:bootHarness` RPC before dialing, which
 * is the final fail-closed guard against a stale or misdirected advertisement.
 */
export async function getPgRelocatedHarnessEndpoint(
  workspaceId: string,
  harnessSlug: string,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<PgRelocatedHarnessEndpoint | null> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  const sidecar = row?.sidecar;
  if (
    !row ||
    !sidecar ||
    typeof sidecar.socketPath !== 'string' ||
    !isAbsolute(sidecar.socketPath) ||
    !Array.isArray(sidecar.handles)
  ) {
    return null;
  }
  const exact = sidecar.handles.some(
    (handle) => handle?.workspaceId === workspaceId && handle?.harnessSlug === harnessSlug,
  );
  if (!exact) return null;
  return { socketPath: sidecar.socketPath, advertisedAt: row.sentAt };
}

/**
 * Resolve the swarm announce identity the substrate owner holds for one exact
 * pot — the WI-2142873 reader.
 *
 * Reads the FULL handle list, not just the sidecar-relocated one: a harness
 * booted IN-PROCESS in the owner is equally invisible to a git-sync routine
 * running elsewhere, and it fails exactly the same way. Scoping this to
 * relocated handles would have fixed one of the two process splits and left
 * the other signing announcements no peer can dial.
 *
 * Returns `null` for UNKNOWN (no fresh row) so a caller can tell "the owner
 * says nothing serves this pot" from "we could not ask" — see
 * `PgBootedHarnessIdentity`.
 */
export async function getPgBootedHarnessAnnounceIdentity(
  workspaceId: string,
  harnessSlug: string,
  opts?: { maxAgeMs?: number; now?: () => number },
): Promise<PgBootedHarnessIdentity | null> {
  const row = await readFreshPgBootedHandlesPayload(opts);
  if (!row) return null;
  const match = row.handles.find(
    (handle) => handle?.workspaceId === workspaceId && handle?.harnessSlug === harnessSlug,
  );
  if (!match) return { booted: false, identity: null, advertisedAt: row.sentAt };
  const identity = match.announceIdentity;
  // A half-identity is not an identity: signing needs BOTH the device peers
  // filed us under and the keychain that can sign as it.
  const usable =
    identity && typeof identity.devicePubkeyBase64 === 'string' && identity.devicePubkeyBase64
      ? identity
      : null;
  return { booted: true, identity: usable, advertisedAt: row.sentAt };
}
