/**
 * agent-fleets-store — PG access to harness_shared.agent_fleets, the durable
 * named-fleet registry (named-su-agent-fleets-2026-06-29, D-001; migration 406).
 *
 * A fleet = a persistent named group of su agents. THIS ROW is the durable
 * identity: it survives all-members-killed, so the fleet stays selectable (D-003).
 * Live membership is a SOFT label on shared_presence (fleet_slug/fleet_role), NOT
 * here. `leaderOwnerId` is the current leader — the agent who created the fleet or
 * last took it on a handoff ("handoff agent becomes leader", D-002).
 *
 * Workspace-scoped: every query carries an explicit `WHERE workspace_id = $1`
 * (RLS is the backstop, mirroring hive-store.ts). Every fn takes an optional `sql`
 * client so integration tests can pass a per-file test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** A named-fleet registry row. */
export interface AgentFleetRecord {
  workspaceId: string;
  fleetSlug: string;
  title: string | null;
  description: string | null;
  /** Coord owner-id that created the fleet. */
  owner: string | null;
  /** The CURRENT leader's coord owner-id (D-002). Null when unset (e.g. the
   *  fleet persists but no agent currently leads it). */
  leaderOwnerId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFleetInput {
  workspaceId: string;
  fleetSlug: string;
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  leaderOwnerId?: string | null;
}

interface FleetRow {
  workspace_id: string;
  fleet_slug: string;
  title: string | null;
  description: string | null;
  owner: string | null;
  leader_owner_id: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: FleetRow): AgentFleetRecord {
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    title: r.title,
    description: r.description,
    owner: r.owner,
    leaderOwnerId: r.leader_owner_id,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, fleet_slug, title, description, owner, leader_owner_id, created_at, updated_at`;

/**
 * Derive a stable fleet_slug from a user-entered fleet NAME. The original name
 * is kept in `title`; this is the kebab-case handle (the durable id + env var
 * value + presence label). Always returns a non-empty slug.
 */
export function fleetSlugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'fleet';
}

/** One fleet by its slug. */
export async function getFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.agent_fleets WHERE workspace_id = $1 AND fleet_slug = $2 LIMIT 1`,
    [workspaceId, fleetSlug],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Every persisted fleet in the workspace, newest first. (These persist even
 *  with zero live members — D-003 — so this is the psu "pick existing" list.) */
export async function listFleets(workspaceId: string, sql?: Sql): Promise<AgentFleetRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.agent_fleets WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )) as unknown as FleetRow[];
  return rows.map(rowToRecord);
}

/**
 * Get-or-create a fleet. Idempotent: an existing (workspace, fleet_slug) row is
 * returned UNCHANGED; title/description/owner/leader apply only on first insert
 * (edit later via updateFleetMeta / setFleetLeader). `created` reflects insert.
 */
export async function createFleetIfAbsent(
  input: CreateFleetInput,
  sql?: Sql,
): Promise<{ record: AgentFleetRecord; created: boolean }> {
  const s = pg(sql);
  const now = Date.now();
  const inserted = (await s.unsafe(
    `INSERT INTO harness_shared.agent_fleets (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (workspace_id, fleet_slug) DO NOTHING
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.fleetSlug,
      input.title ?? null,
      input.description ?? null,
      input.owner ?? null,
      input.leaderOwnerId ?? null,
      now,
    ],
  )) as unknown as FleetRow[];
  if (inserted[0]) return { record: rowToRecord(inserted[0]), created: true };
  const existing = await getFleet(input.workspaceId, input.fleetSlug, sql);
  if (!existing) {
    throw new Error(
      `createFleetIfAbsent: conflict on (${input.workspaceId}, ${input.fleetSlug}) but no row found`,
    );
  }
  return { record: existing, created: false };
}

/**
 * Set the current leader (D-002: the handoff agent becomes leader). Pass null to
 * clear. Idempotent; bumps updated_at. Returns null if the fleet doesn't exist.
 */
export async function setFleetLeader(
  workspaceId: string,
  fleetSlug: string,
  leaderOwnerId: string | null,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_owner_id = $3, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, leaderOwnerId, Date.now()],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Edit a fleet's directory metadata (title/description). No leader side effects. */
export async function updateFleetMeta(
  workspaceId: string,
  fleetSlug: string,
  meta: { title?: string | null; description?: string | null },
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET title = COALESCE($3, title),
            description = COALESCE($4, description),
            updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, meta.title ?? null, meta.description ?? null, Date.now()],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Delete a fleet registry row. Idempotent. */
export async function deleteFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.agent_fleets WHERE workspace_id = $1 AND fleet_slug = $2 RETURNING fleet_slug`,
    [workspaceId, fleetSlug],
  )) as unknown as Array<{ fleet_slug: string }>;
  return rows.length > 0;
}
