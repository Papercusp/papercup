/**
 * fleet-membership-store — the ONE write path for named-fleet membership
 * (presence-coord-unification-2026-07-01 P-002 / WI-1345).
 *
 * Canonical membership is an APPEND-ONLY fact: harness_shared.fleet_membership_events
 * ("agent X is member|leader of / left fleet Y at T", migration 430). This module is the
 * only place the app appends one. coord_presence.fleet_slug/fleet_role are a PROJECTION of
 * it — maintained by DB triggers and re-materialized after death — never written directly
 * (a DB guard rejects a direct UPDATE). So membership survives the presence reaper, and
 * "who was ever in fleet X" is a durable history read over this log.
 *
 * The `sql?` seam lets a caller thread a transaction (e.g. an atomic leadership transfer)
 * or a per-file test schema, mirroring agent-fleets-store.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** The human-readable event label recorded on a membership fact (does not affect the
 *  projection, which is purely the latest fact's fleet_slug/fleet_role). */
export type FleetMembershipEvent = 'join' | 'leave' | 'lead' | 'demote' | 'backfill';

export interface FleetMembershipInput {
  workspaceId: string;
  ownerId: string;
  /** Fleet joined; null = the agent left / is in no fleet (clears the projection). */
  fleetSlug: string | null;
  /** 'leader' | 'member' | null. */
  fleetRole: string | null;
  ownerLabel?: string | null;
  /** Override the derived event label. */
  event?: FleetMembershipEvent;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** Derive a sensible event label from the (slug, role) target when the caller
 *  doesn't specify one: a null slug is a leave; a leader label is a lead; else a join. */
export function deriveFleetMembershipEvent(
  fleetSlug: string | null,
  fleetRole: string | null,
): FleetMembershipEvent {
  if (fleetSlug == null) return 'leave';
  return fleetRole === 'leader' ? 'lead' : 'join';
}

/**
 * Append a membership FACT — the canonical, append-only source of truth. The DB
 * projection trigger mirrors it onto the live coord_presence row (if one exists);
 * the fact itself is durable and re-materializes on the agent's next presence write.
 */
export async function appendFleetMembershipEvent(
  input: FleetMembershipInput,
  sql?: Sql,
): Promise<void> {
  const s = pg(sql);
  const event = input.event ?? deriveFleetMembershipEvent(input.fleetSlug, input.fleetRole);
  await s`
    INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
    VALUES (${input.workspaceId}, ${input.ownerId}, ${input.ownerLabel ?? null},
            ${input.fleetSlug}, ${input.fleetRole}, ${event})
  `;
}

/**
 * Populate-once: append a membership fact ONLY if the owner has no prior fact. The
 * durable analog of the old env-fold `COALESCE(fleet_slug, env)` "the first declared
 * write populates them, every later one preserves" semantic — now a single-statement
 * conditional INSERT so a leader role a handoff promoted this owner to is never
 * clobbered back to the env default, and a re-declaring agent never re-appends.
 */
export async function appendFleetMembershipIfAbsent(
  input: FleetMembershipInput,
  sql?: Sql,
): Promise<void> {
  const s = pg(sql);
  const event = input.event ?? deriveFleetMembershipEvent(input.fleetSlug, input.fleetRole);
  await s`
    INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
    SELECT ${input.workspaceId}, ${input.ownerId}, ${input.ownerLabel ?? null},
           ${input.fleetSlug}, ${input.fleetRole}, ${event}
     WHERE NOT EXISTS (
       SELECT 1 FROM harness_shared.fleet_membership_events e
        WHERE e.workspace_id = ${input.workspaceId} AND e.owner_id = ${input.ownerId}
     )
  `;
}

/**
 * The canonical CURRENT membership for an owner: the latest fact (MAX id). Returns null
 * when the owner has no membership fact at all; a returned `{ fleetSlug: null }` means the
 * owner's latest fact was a leave (explicitly in no fleet). This is the same projection the
 * DB triggers apply to coord_presence, exposed for reads that must survive agent death.
 */
export async function latestFleetMembership(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<{ fleetSlug: string | null; fleetRole: string | null } | null> {
  const s = pg(sql);
  const rows = await s<{ fleet_slug: string | null; fleet_role: string | null }[]>`
    SELECT fleet_slug, fleet_role
      FROM harness_shared.fleet_membership_events
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     ORDER BY id DESC
     LIMIT 1
  `;
  return rows[0] ? { fleetSlug: rows[0].fleet_slug, fleetRole: rows[0].fleet_role } : null;
}
