/**
 * bee-runs.ts — the live-execution view's projection
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * A **bee run** (D-007 — deliberately NOT a "workflow": that name collides with DBOS
 * workflows, which key on workflow_id, AND the harness pipeline) is a bee currently
 * executing a claimed work-item under its scheduling spec. This module projects each
 * running bee run off the LIVE state — never a separate store:
 *
 *   - the bee / current item / claimed-since / lease / heartbeat / progress, and the
 *     derived idle/blocked reason, come straight from the canonical reconciled
 *     `fleet_assignment` view (the SAME work-item-claim + holder-liveness the reconciler
 *     reads), via {@link deriveActivity} — so the run's liveness can never drift from
 *     fleet:assignments;
 *   - the claim-spec `specId@revision` the bee is running under is joined from the per-bee
 *     `bee_claim_specs` store (null ⇒ the DEFAULT ordering — no Queen-authored spec).
 *
 * The projection (toBeeRun / summarizeBeeRuns / idleReason) is PURE so it unit-tests with
 * synthetic rows and no PG; {@link listBeeRuns} is the thin I/O glue over
 * listFleetAssignments + the spec batch.
 */
import { deriveActivity, listFleetAssignments, type FleetAssignmentRow } from '../fleet/assignments';
import type { ItemActivity } from '../item-activity';
import { activeWorkspaceId } from '../workspace-registry';
import { getClaimSpecHeadsForBees } from './claim-spec-store';

/** The claim-spec head a running bee is executing under (from bee_claim_specs). */
export interface RunningSpecHead {
  specId: string;
  revision: number;
}

/** One running **bee run** (D-007) — a bee executing a claimed work-item, live. */
export interface BeeRun {
  /** The executing bee (claim holder ownerId). */
  bee: string;
  beeLabel: string | null;
  /** The work-item the bee is running (WI-/F-/EI- id). */
  item: string;
  itemKind: string | null;
  title: string;
  status: string | null;
  harness: string | null;
  plan: string | null;
  /** When the bee claimed this item (claimed-since). */
  claimedSince: string | null;
  /** The claim lease expiry, or null when this leg carries no lease. */
  leaseExpiresAt: string | null;
  /** The holder's last process heartbeat. */
  heartbeatAt: string | null;
  /** Last REAL item-scoped progress on the run (a state transition / checkpoint), or null. */
  lastProgressAt: string | null;
  /** The single derived liveness truth: free|reserved|alive|progressing|stalled|dead. */
  activity: ItemActivity;
  /** Human idle/blocked reason — null when the run is actively progressing. */
  idleReason: string | null;
  /** The claim-spec the bee runs under, or null ⇒ DEFAULT ordering (no spec set). */
  spec: RunningSpecHead | null;
}

/**
 * The human "why isn't this advancing?" line for an activity verdict. `progressing` (the
 * healthy case) and the n/a `free` have no reason; the rest explain the idle / blocked /
 * reclaimable state so a reader never mistakes a stale claim for live work.
 */
export function idleReason(activity: ItemActivity): string | null {
  switch (activity) {
    case 'progressing':
      return null;
    case 'alive':
      return 'claimed, no item progress recorded yet (grace window)';
    case 'reserved':
      return 'claimed, holder liveness unknown (no presence record yet)';
    case 'stalled':
      return 'no item progress within the staleness window — reclaimable';
    case 'dead':
      return 'holder is gone (orphaned claim) — reclaimable';
    case 'free':
      return null;
  }
}

/**
 * Project one canonical `fleet_assignment` work-item-claim row + the bee's spec head into a
 * BeeRun. PURE — the idle/blocked reason reuses the canonical {@link deriveActivity} so it
 * agrees with fleet:assignments by construction.
 */
export function toBeeRun(row: FleetAssignmentRow, spec: RunningSpecHead | null = null): BeeRun {
  const activity = deriveActivity(row);
  return {
    bee: row.agentId ?? '',
    beeLabel: row.agentLabel,
    item: row.workItemId ?? row.itemId ?? '',
    itemKind: row.itemKind,
    title: row.detail,
    status: row.status,
    harness: row.harnessSlug,
    plan: row.planSlug,
    claimedSince: row.claimAcquiredTs,
    leaseExpiresAt: row.claimExpiresTs,
    heartbeatAt: row.holderHeartbeatAt,
    lastProgressAt: row.lastProgressAt,
    activity,
    idleReason: idleReason(activity),
    spec,
  };
}

/** Roll up bee runs by activity — the live-execution summary header. */
export function summarizeBeeRuns(runs: BeeRun[]): {
  total: number;
  progressing: number;
  idle: number;
  stalled: number;
  dead: number;
} {
  return {
    total: runs.length,
    progressing: runs.filter((r) => r.activity === 'progressing').length,
    // alive + reserved = claimed but not yet advancing (starting / liveness-unknown).
    idle: runs.filter((r) => r.activity === 'alive' || r.activity === 'reserved').length,
    stalled: runs.filter((r) => r.activity === 'stalled').length,
    dead: runs.filter((r) => r.activity === 'dead').length,
  };
}

export interface ListBeeRunsOpts {
  /** Scope to one harness (the bee runs executing there). */
  harness?: string;
  /** Workspace scope; defaults to the active workspace. */
  workspaceId?: string | null;
  /** Filter to one bee (its ownerId). */
  bee?: string;
}

/**
 * The live-execution view: every live bee run (a bee executing a claimed work-item),
 * projected off the canonical fleet_assignment view + the per-bee spec store. A bee run is
 * exactly a LIVE work-item claim — plan-item leases + presence rows are not bee runs, so
 * they are filtered out. The view excludes terminal-status items by construction (the
 * fleet_assignment work-item-claim leg drops them), so a done/dropped item never appears.
 */
export async function listBeeRuns(opts: ListBeeRunsOpts = {}): Promise<BeeRun[]> {
  const rows = await listFleetAssignments({
    workspaceId: opts.workspaceId ?? activeWorkspaceId(),
    harness: opts.harness,
    agent: opts.bee,
    activeOnly: true,
  });
  // A bee run = a live work-item claim (the executing unit).
  const claims = rows.filter((r) => r.source === 'work_item_claim' && r.workItemId);
  const bees = [...new Set(claims.map((r) => r.agentId).filter((b): b is string => !!b))];
  const specs = await getClaimSpecHeadsForBees(bees, opts.workspaceId ?? undefined);
  return claims.map((r) => toBeeRun(r, (r.agentId ? specs.get(r.agentId) : null) ?? null));
}
