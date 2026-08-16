/**
 * host-capacity.ts — refuse a proc-mesh that cannot FIT on this host, BEFORE
 * spawning it.
 *
 * WHY THIS EXISTS (measured 2026-08-16, WI-39359):
 * The >64-peer `replication.sustained` ladder produced a convergence signal that
 * looked like a substrate mesh-formation defect and was NOT one. Each perf peer
 * child holds ~430-550MB RSS (`childRssPeak` p50), so an 80-peer mesh needs
 * ~38-42GB and a 96-peer mesh ~41-53GB of anonymous memory. On a shared box
 * already holding a large agent fleet, the run SELF-OVERSUBSCRIBED: one pass
 * began at loadavg 52 / PSI cpu some avg60 0.96% and ended at loadavg 265
 * (2.07x cpus) having moved 470,555 swap pages. Readers then miss the
 * convergence budget because they are SWAPPED, not because the mesh failed.
 *
 * The tell that this is not a capacity ceiling of the substrate: the per-config
 * failure pattern is NOT REPRODUCIBLE. Across two runs of the same four configs,
 * 96@100 went 22/95 -> 95/95 while 96@10 went 95/95 -> 51/95. A real ceiling
 * cannot invert. Failing readers cluster just under the budget (115-116s of
 * 120s) — deadline clipping of an across-the-board-slow distribution.
 *
 * The runner already owns an AFTER-THE-FACT host-health verdict (EI-8843 load
 * ratio, EI-9145 swap delta, EI-19301664378023382 PSI). That marks the number
 * uncertain once it has already been paid for, and it does not stop the run from
 * degrading the shared box for every other agent on it. This guard is the
 * BEFORE half: if the mesh provably cannot fit, refusing is strictly better than
 * emitting a verdict nobody may quote.
 *
 * This is the FOURTH time in this lane the instrument, not the substrate, was
 * the defect (serial per-reader deadline; convergence-budget drift; hyperswarm's
 * default `MAX_PEERS = 64`; now per-peer RSS vs host memory). Hence a guard
 * rather than a note: a note does not survive the next agent.
 */

import { readFileSync } from 'node:fs';

/**
 * Per-peer resident-memory budget. Anchored on the measured `childRssPeak` p50
 * across four >64-peer configs (429MB, 478MB, 525MB, 551MB); the default sits
 * near the low end deliberately, so the guard errs toward ALLOWING a run rather
 * than blocking a legitimate one.
 */
export const DEFAULT_PER_PEER_RSS_BYTES = 450_000_000;

/**
 * Fraction of `MemAvailable` a mesh may claim.
 *
 * NOT 1.0, and the reason is empirical rather than superstitious: `MemAvailable`
 * counts reclaimable page cache as available, but a mesh that claims it forces
 * the kernel to evict tens of GB of other agents' working set and then swap. At
 * the measured footprint this factor puts the fit boundary between 64 peers
 * (~29GB, the largest count that has ever produced a clean, reproducible result
 * here) and 80 peers (~36GB, the smallest that has not).
 */
export const DEFAULT_AVAILABLE_FRACTION = 0.5;

export interface MeshCapacityDecision {
  ok: boolean;
  /** Human-readable refusal, present only when `ok` is false. */
  reason?: string;
  projectedBytes: number;
  budgetBytes: number;
}

/**
 * PURE fit decision — no `/proc`, no env, no clock, so it is unit-testable and
 * cannot silently pass because the host happened to be idle.
 *
 * `availableBytes === null` means "this host does not report available memory"
 * (non-Linux, or an unreadable /proc): the guard then ABSTAINS rather than
 * guessing. Abstaining restores exactly the old behaviour, which is the correct
 * failure mode for a guard that is not the thing under test.
 */
export function decideMeshCapacity(input: {
  /** Total peer processes to be spawned, INCLUDING the writer. */
  peers: number;
  availableBytes: number | null;
  perPeerBytes?: number;
  availableFraction?: number;
}): MeshCapacityDecision {
  const perPeer = input.perPeerBytes ?? DEFAULT_PER_PEER_RSS_BYTES;
  const fraction = input.availableFraction ?? DEFAULT_AVAILABLE_FRACTION;
  const projectedBytes = input.peers * perPeer;

  if (input.availableBytes === null) {
    return { ok: true, projectedBytes, budgetBytes: Number.POSITIVE_INFINITY };
  }

  const budgetBytes = input.availableBytes * fraction;
  if (projectedBytes <= budgetBytes) return { ok: true, projectedBytes, budgetBytes };

  const gb = (b: number) => `${(b / 1e9).toFixed(1)}GB`;
  return {
    ok: false,
    projectedBytes,
    budgetBytes,
    reason:
      `host cannot fit a ${input.peers}-peer proc mesh: needs ~${gb(projectedBytes)} ` +
      `(${input.peers} x ~${gb(perPeer)}/peer, measured childRssPeak p50) but only ` +
      `${gb(budgetBytes)} is safely claimable (${(fraction * 100).toFixed(0)}% of ` +
      `MemAvailable ${gb(input.availableBytes)}). Running anyway would swap, and a ` +
      `swapped reader misses the convergence budget for reasons that have NOTHING to ` +
      `do with this substrate — the resulting verdict would be unquotable. ` +
      `Re-run on a quieter/larger host, or override with ` +
      `PERF_MESH_AVAILABLE_FRACTION / PERF_MESH_PER_PEER_BYTES if you know better.`,
  };
}

/** Parse `MemAvailable` (kB) out of /proc/meminfo text. Pure, so it is testable. */
export function parseMemAvailableBytes(meminfo: string): number | null {
  const line = meminfo.split('\n').find((l) => l.startsWith('MemAvailable:'));
  if (!line) return null;
  const kb = Number(line.replace(/[^0-9]/g, ''));
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** Read MemAvailable, or null on any host that does not report it. */
export function readMemAvailableBytes(): number | null {
  try {
    return parseMemAvailableBytes(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return null;
  }
}

/** Env overrides, so a deliberate operator can still force a run. */
export function capacityOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  perPeerBytes?: number;
  availableFraction?: number;
} {
  const num = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    perPeerBytes: num(env.PERF_MESH_PER_PEER_BYTES),
    availableFraction: num(env.PERF_MESH_AVAILABLE_FRACTION),
  };
}

/**
 * Thrown by `spawnProcMesh` when the mesh provably does not fit. Deliberately
 * NOT a `MeshFormationError`: that type means "the mesh was attempted and did
 * not form", which netem folds into a `did-not-form` MEASUREMENT. This never ran
 * at all, so recording it as an outcome of the profile would be a false datum.
 */
export class HostCapacityError extends Error {
  constructor(
    message: string,
    readonly decision: MeshCapacityDecision,
  ) {
    super(message);
    this.name = 'HostCapacityError';
  }
}
