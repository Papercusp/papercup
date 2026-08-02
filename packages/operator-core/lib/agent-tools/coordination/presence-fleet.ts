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

/** One fleet member's presence row, as the respawn/launch verification reads it. */
export interface FleetPresenceRow {
  ownerId: string;
  startedAt: Date;
  heartbeatAt: Date;
}

/**
 * IO seam: the fleet's CURRENT presence roster (every owner labeled into `fleetSlug`),
 * newest-heartbeat first. Backed by the (workspace_id, fleet_slug) partial index.
 *
 * This is the "did a launch actually produce an agent?" oracle: a launcher can only
 * report that it spawned a terminal, and that terminal's wrapper survives the CLI dying
 * instantly — so a launch is verified by a NEW owner appearing here with a live
 * heartbeat, never by the launcher's own return value.
 */
export async function listFleetPresence(
  workspaceId: string,
  fleetSlug: string,
): Promise<FleetPresenceRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ owner_id: string; started_at: Date; heartbeat_at: Date }[]>`
    SELECT owner_id, started_at, heartbeat_at
      FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug = ${fleetSlug}
     ORDER BY heartbeat_at DESC
  `;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
  }));
}

/**
 * Resolve one caller's CURRENT fleet membership from coord presence, with the
 * launch environment used only when the authoritative read itself fails.
 *
 * A successful read that returns no row is meaningful: the caller has left its
 * fleet (or was demoted out of it). Falling back to PAPERCUSP_FLEET_* in that
 * case resurrects stale launch-time membership and is the root cause of
 * monitor-orient returning only the caller while fleet:leader-brief, when
 * explicitly scoped, returns the real roster. Dynamic fleet:join /
 * fleet:take-leadership mutations cannot rewrite an already-running process's
 * environment, so every live read surface must prefer coord_presence.
 */
export async function resolvePresenceFleet(
  ownerId: string | undefined,
  launchFallback: FleetMembership,
  fetcher: (ownerIds: string[]) => Promise<Map<string, FleetMembership>> = fetchPresenceFleet,
): Promise<FleetMembership> {
  if (!ownerId) return launchFallback;
  try {
    const memberships = await fetcher([ownerId]);
    return memberships.get(ownerId) ?? { fleetSlug: null, fleetRole: null };
  } catch {
    return launchFallback;
  }
}
