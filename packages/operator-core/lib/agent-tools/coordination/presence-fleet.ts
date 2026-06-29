/**
 * presence-fleet.ts — the per-agent named-fleet membership read
 * (named-su-agent-fleets-2026-06-29 P-005).
 *
 * fleet_slug / fleet_role are a SOFT membership label on harness_shared.coord_presence
 * (migration 407, the per-agent mirror of hive_slug). hive_slug rides the PresenceRecord
 * the @papercusp/coordination store reads; fleet_slug does NOT (the store's SELECT is
 * unchanged), so the coordination tools join it in HERE — the same per-owner enrichment
 * shape as `fetchPresenceTier1`: ONE batch query keyed by the roster's ownerIds, so
 * enriching N agents is a constant read, not N. Only rows that actually carry a
 * fleet_slug come back; a non-fleet agent is simply absent from the map (its surfaces
 * default to null/omitted).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { FleetMembership } from './identity';

export type { FleetMembership };

/**
 * IO seam: batch-read the fleet membership label for a set of ownerIds from
 * coord_presence. ownerIds should be the LOCAL roster (federated `fed:…` ids never
 * match a local coord_presence row, so passing them just wastes a comparison).
 * Returns one entry per owner that carries a fleet_slug.
 */
export async function fetchPresenceFleet(
  ownerIds: string[],
): Promise<Map<string, FleetMembership>> {
  const out = new Map<string, FleetMembership>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<{ owner_id: string; fleet_slug: string | null; fleet_role: string | null }[]>`
    SELECT owner_id, fleet_slug, fleet_role
      FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${ownerIds}::text[])
       AND fleet_slug IS NOT NULL
  `;
  for (const r of rows) {
    out.set(r.owner_id, { fleetSlug: r.fleet_slug, fleetRole: r.fleet_role });
  }
  return out;
}
