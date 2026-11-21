/** Exact work-item fleets use the existing durable claim-spec store, never a second queue. */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import { DEFAULT_CLAIM_SPEC, appendIdsToClaimSpec, positiveIdCohortIds, validateClaimSpec, type ClaimSpec } from './claim-spec';
import { fleetSpecBeeKey, getClaimSpecRecord, setClaimSpec } from './claim-spec-store';

export function buildFleetWorkItemsClaimSpec(fleet: string, workItems: readonly string[]): ClaimSpec {
  if (!workItems.length || workItems.some(id => !id || id.length > 80 || id !== id.trim())) {
    throw new Error('workItems requires intact, nonempty work-item ids of at most 80 characters');
  }
  return { ...DEFAULT_CLAIM_SPEC, specId: `fleet-launch-${fleet}-work-items`, revision: 1,
    view: { filter: { field: 'id', op: 'in', value: [...new Set(workItems)] } } };
}

/** The scheduler's family-complete floors include unfinished blocks edges. Unknown refuses. */
export async function preflightFleetWorkItems(args: {
  workspaceId: string; harness: string; fleetSlug: string; workItems: readonly string[]; requestedSeats: number;
}) {
  const spec = buildFleetWorkItemsClaimSpec(args.fleetSlug, args.workItems);
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`SELECT feature_id AS id FROM harness_shared.work_items
    WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harness}
      AND feature_id = ANY(${[...args.workItems]}::text[])`;
  const found = new Set(rows.map(row => row.id));
  const missing = args.workItems.filter(id => !found.has(id));
  if (missing.length) return { ready: false, reason: 'work-items-not-found', missing,
    requestedSeats: args.requestedSeats, executableWidth: null, seatShortfall: null };
  const { readClaimSpecLaneHealth } = await import('../fleet/lane-health');
  const lane = await readClaimSpecLaneHealth({ workspaceId: args.workspaceId, harness: args.harness, fleet: args.fleetSlug,
    spec, record: { source: 'fleet', spec, revision: 1, updatedBy: null, updatedAt: null, fleetSlug: args.fleetSlug } });
  const width = lane?.effective.claimable ?? null;
  return { ready: width !== null && width >= args.requestedSeats,
    reason: width === null ? 'lane-unknown' : width < args.requestedSeats ? 'insufficient-executable-width' : 'ready',
    requestedSeats: args.requestedSeats, executableWidth: width,
    seatShortfall: width === null ? null : Math.max(0, args.requestedSeats - width), lane };
}

/** Live parent fence applies even to an incumbent per-member override. */
export function fenceMemberWorkItems(member: ClaimSpec, parent: ClaimSpec): ClaimSpec {
  const ids = positiveIdCohortIds(parent.view.filter);
  if (ids === null) return member;
  const fence = { field: 'id' as const, op: 'in' as const, value: ids };
  return { ...member, view: { ...member.view,
    filter: member.view.filter ? { all: [fence, member.view.filter] } : fence } };
}

/** Called inside work-item creation's transaction. No dynamic fleet is converted to a fixed set. */
export async function enrollFleetWorkItems(args: {
  workspaceId: string; fleetSlug: string; workItemIds: string[]; updatedBy: string;
}, sqlOverride?: OrgSql): Promise<{ enrolled: boolean; workItems: string[] }> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const apply = async (tx: OrgSql) => {
    const cupId = fleetSpecBeeKey(args.fleetSlug);
    await tx`SELECT bee_id FROM harness_shared.cup_claim_specs
      WHERE workspace_id = ${args.workspaceId} AND bee_id = ${cupId} FOR UPDATE`;
    const current = await getClaimSpecRecord({ cupId, workspaceId: args.workspaceId }, tx);
    if (current.source !== 'fleet' || positiveIdCohortIds(current.spec.view.filter) === null) {
      return { enrolled: false, workItems: [] };
    }
    // Validate identities without truncating or silently discarding one.
    buildFleetWorkItemsClaimSpec(args.fleetSlug, args.workItemIds);
    const spec = appendIdsToClaimSpec(current.spec, args.workItemIds)!;
    const validated = validateClaimSpec(spec);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    const result = await setClaimSpec({ cupId, workspaceId: args.workspaceId, spec,
      updatedBy: args.updatedBy, potSlug: current.harnessSlug }, tx);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return { enrolled: true, workItems: positiveIdCohortIds(spec.view.filter)! };
  };
  return sqlOverride ? apply(sql) : sql.begin(tx => apply(tx as unknown as OrgSql));
}
