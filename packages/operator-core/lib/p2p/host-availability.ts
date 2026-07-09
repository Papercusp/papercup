/**
 * p2p/host-availability.ts — WI-1937 production build of the D-007
 * `HostAvailability` snapshot (claim-authority.ts's `{ remote, local }`
 * input to `evaluateClaimAuthority`), consumed by BOTH the P-103 standing
 * puller (`PullEvaluationInput.hostAvailability`) and the P-104
 * offer-executor's `OfferExecutorDeps.hostAvailability` — one builder, two
 * callers, so the two gates can never disagree about "what does this host
 * have right now".
 *
 * Composes:
 *   POLICY layer (real) — this host's P-201 resource-allotments for the
 *     offer's fleet, minus P-205 committed spend (metering-ledger /
 *     metering-store). Only the ABSOLUTE forward-seam fields
 *     (`axis.dollarCapUsd` for 'account' rows, `axis.slots` for 'gpu' rows —
 *     see resource-allotments.ts's `ResourceAllotment.axis` doc) are
 *     resolvable today; a `sharePct`-only row (no absolute cap set) has no
 *     defined "pool budget" to take a percentage OF anywhere in this
 *     codebase yet, so it contributes 0 to the cap rather than guess —
 *     fail-closed, not fail-open, on an unresolved axis.
 *   PHYSICS layer — real-time headroom. **Fail-closed to 0 for BOTH axes in
 *     this v1**: no real-time gateway-account-rate-room reader (remote) or
 *     local-inference-slot reader (local) is wired yet. This is the SAME
 *     fail-closed convention `claim-authority.ts`'s doc comment already
 *     mandates for the local axis (M12: "0 / fail-closed until those deltas
 *     land") — applied here to the remote axis too, rather than fabricate a
 *     number that could fail OPEN on a foreign-code-execution gate. The
 *     practical effect: `axisAvailable` is 0 today (`min(cap, 0) === 0`), so
 *     every claim this composes into is refused — inert, never permissive,
 *     until a follow-up wires real headroom (tracked: WI-3590, filed
 *     alongside this module).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import {
  axisForResourceKind,
  type AxisAvailability,
  type HostAvailability,
} from './claim-authority';
import type { BudgetAxis } from './offer-budget';
import { spentOn } from './metering-ledger';
import { loadMeteringLedger } from './metering-store';
import { listResourceAllotments, resolveAllotmentWorkspace, type ResourceAllotment } from './resource-allotments';

/** The absolute cap (in the axis's native unit) ONE allotment row contributes,
 *  or 0 when the row carries no resolvable absolute forward-seam value (see
 *  module doc — a sharePct-only row is not yet resolvable). */
function absoluteCapOf(row: Pick<ResourceAllotment, 'resourceKind' | 'axis'>): number {
  if (row.resourceKind === 'account') {
    const usd = row.axis?.dollarCapUsd;
    // BudgetUnit for 'remote' is 'usd-micros' (offer-budget.ts) — dollarCapUsd is USD.
    return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0;
  }
  if (row.resourceKind === 'gpu') {
    const slots = row.axis?.slots;
    return typeof slots === 'number' && Number.isFinite(slots) && slots > 0 ? slots : 0;
  }
  return 0; // agent_slot excluded from budget math (D-002, axisForResourceKind)
}

export interface HostAvailabilityContext {
  /** The caller's RESOLVED identity workspace (same C3/WI-1564 partition every other p2p store uses). */
  workspaceId: string | null | undefined;
  /** THIS host's own identity ref for the P-205 metering ledger (`host_ref` column) —
   *  must be the SAME ref the spend-recording leg stamps when a foreign session draws,
   *  or `allotmentRemaining` will never reflect real spend. */
  hostRef: string;
}

/**
 * Build a live `HostAvailability` snapshot for `fleetSlug` on this host. No
 * caching — always freshly read (D-007 requires a spawn-time re-check, never
 * a stale snapshot: leases ADVISE, this gate DECIDES). `null` per-axis = M11
 * default-zero (this host serves no allotment for that axis on this fleet).
 */
export async function hostAvailability(
  ctx: HostAvailabilityContext,
  fleetSlug: string,
  sqlOverride?: OrgSql,
): Promise<HostAvailability> {
  const ws = resolveAllotmentWorkspace(ctx.workspaceId);
  if (!ws) return { remote: null, local: null };

  const sql = sqlOverride ?? getOrgPg().sql;
  const [allotments, ledger] = await Promise.all([
    listResourceAllotments({ workspaceId: ctx.workspaceId, fleetSlug }, sql),
    loadMeteringLedger(ws, sql),
  ]);

  const capByAxis: Record<BudgetAxis, number> = { remote: 0, local: 0 };
  const servedByAxis: Record<BudgetAxis, boolean> = { remote: false, local: false };
  for (const row of allotments) {
    if (row.resourceKind !== 'account' && row.resourceKind !== 'gpu') continue;
    const axis = axisForResourceKind(row.resourceKind);
    servedByAxis[axis] = true;
    capByAxis[axis] += absoluteCapOf(row);
  }

  const axisSnapshot = (axis: BudgetAxis): AxisAvailability | null => {
    if (!servedByAxis[axis]) return null; // M11: no allotment row on this axis for this fleet
    const spent = spentOn(ledger, ctx.hostRef, fleetSlug, axis);
    return {
      allotmentRemaining: Math.max(0, capByAxis[axis] - spent),
      // PHYSICS: fail-closed v1 — see module doc (WI-3590 follow-up).
      liveHeadroom: 0,
    };
  };

  return { remote: axisSnapshot('remote'), local: axisSnapshot('local') };
}
