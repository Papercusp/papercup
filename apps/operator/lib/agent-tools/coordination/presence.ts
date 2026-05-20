/**
 * presence.ts — the L1 liveness layer over harness_shared.coord_presence.
 *
 * agent-coordination-architecture-v2 §4.2. Two-part presence:
 *
 *   - DURABLE record  → harness_shared.power_user_sessions (shipped;
 *     owned by the OMP-bundle work). Identity, workspace, created/
 *     revoked. Not a heartbeat.
 *   - LIVE record     → harness_shared.coord_presence (this module).
 *     Frequent heartbeat + declared intent + current work.
 *
 * `listPresence` LEFT-JOINs the two so a power-user agent shows both
 * its durable and live state, while a superuser engineer (no
 * power_user_sessions row) still shows up from coord_presence alone.
 *
 * Held locks are intentionally NOT stored here — they live in the
 * SU-locks `agent_file_locks` table in the separate `papercusp_su`
 * database. `coord:presence` can join them in with a second query
 * against the locks store; this module stays single-database.
 *
 * Server-only — uses the raw postgres-js client (the table is
 * runtime-ensured, not drizzle-introspected), matching the sibling
 * power-user-sessions.ts.
 */

import { getOrgPg } from '@restart/db-org';
import { ensureCoordPresenceTable } from '@/lib/ensure-schema';
import type { AgentIdentity } from './identity';

/** A session whose heartbeat is older than this is treated as dead. */
export const PRESENCE_STALE_MS = 10 * 60 * 1000;

/** Mutable work-state an agent declares about itself. */
export interface PresenceInput {
  intent?: string;
  currentPlanSlug?: string | null;
  currentFiles?: string[];
  host?: string;
  pid?: number | null;
}

export interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  workspaceId: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  host: string;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  /** heartbeat older than PRESENCE_STALE_MS — the session is dead. */
  stale: boolean;
  /** Durable power_user_sessions fields — null for a superuser engineer. */
  userId: string | null;
  /** True iff a power_user_sessions row exists and is revoked. */
  revoked: boolean;
}

interface CoordPresenceDbRow {
  owner_id: string;
  owner_label: string;
  workspace_id: string;
  source: string;
  intent: string;
  current_plan_slug: string | null;
  current_files: unknown;
  host: string;
  pid: number | null;
  started_at: string;
  heartbeat_at: string;
  user_id: string | null;
  revoked_at: string | null;
}

function toRecord(r: CoordPresenceDbRow, now: number): PresenceRecord {
  const files = Array.isArray(r.current_files)
    ? (r.current_files as string[])
    : [];
  return {
    ownerId: r.owner_id,
    ownerLabel: r.owner_label,
    workspaceId: r.workspace_id,
    source: r.source,
    intent: r.intent,
    currentPlanSlug: r.current_plan_slug,
    currentFiles: files,
    host: r.host,
    pid: r.pid,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
    stale: now - new Date(r.heartbeat_at).getTime() > PRESENCE_STALE_MS,
    userId: r.user_id,
    revoked: r.revoked_at != null,
  };
}

/**
 * Upsert the caller's presence row — "set my presence to exactly this".
 * Used by the OMP hook's session_start handler and by coord:declare-intent.
 * Always bumps heartbeat_at. Omitted optional fields reset to defaults,
 * so a caller that wants to keep its current plan/files should pass them.
 */
export async function writePresence(
  identity: AgentIdentity,
  input: PresenceInput = {},
): Promise<void> {
  await ensureCoordPresenceTable();
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, intent,
       current_plan_slug, current_files, host, pid, heartbeat_at)
    VALUES (
      ${identity.ownerId}, ${identity.ownerLabel},
      ${identity.workspaceId ?? 'default'}, ${identity.source},
      ${input.intent ?? ''}, ${input.currentPlanSlug ?? null},
      ${JSON.stringify(input.currentFiles ?? [])}::jsonb,
      ${input.host ?? ''}, ${input.pid ?? null}, now()
    )
    ON CONFLICT (owner_id) DO UPDATE SET
      owner_label       = EXCLUDED.owner_label,
      workspace_id      = EXCLUDED.workspace_id,
      source            = EXCLUDED.source,
      intent            = EXCLUDED.intent,
      current_plan_slug = EXCLUDED.current_plan_slug,
      current_files     = EXCLUDED.current_files,
      host              = EXCLUDED.host,
      pid               = EXCLUDED.pid,
      heartbeat_at      = now()
  `;
}

/**
 * Bump heartbeat_at only — the lightweight turn_start path. Does not
 * touch intent / current work. No-op if the row does not exist yet
 * (session_start writes the row first).
 */
export async function touchHeartbeat(ownerId: string): Promise<void> {
  await ensureCoordPresenceTable();
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.coord_presence
       SET heartbeat_at = now()
     WHERE owner_id = ${ownerId}
  `;
}

/** Remove the caller's presence row — the session_shutdown path. */
export async function clearPresence(ownerId: string): Promise<void> {
  await ensureCoordPresenceTable();
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.coord_presence WHERE owner_id = ${ownerId}
  `;
}

/**
 * List presence records, newest heartbeat first. Optionally scoped to
 * one workspace. Each record is classified `stale` by heartbeat age;
 * callers split active vs stale on that flag.
 */
export async function listPresence(
  opts: { workspaceId?: string | null } = {},
): Promise<PresenceRecord[]> {
  await ensureCoordPresenceTable();
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? null;
  const rows = await sql<CoordPresenceDbRow[]>`
    SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
           cp.intent, cp.current_plan_slug, cp.current_files,
           cp.host, cp.pid, cp.started_at, cp.heartbeat_at,
           pus.user_id, pus.revoked_at
      FROM harness_shared.coord_presence cp
      LEFT JOIN harness_shared.power_user_sessions pus
        ON pus.auth_session_id = cp.owner_id
     WHERE ${ws == null ? sql`TRUE` : sql`cp.workspace_id = ${ws}`}
     ORDER BY cp.heartbeat_at DESC
  `;
  const now = Date.now();
  return rows.map((r) => toRecord(r, now));
}

/** Read one presence record by owner id, or null. */
export async function getPresence(
  ownerId: string,
): Promise<PresenceRecord | null> {
  await ensureCoordPresenceTable();
  const { sql } = getOrgPg();
  const rows = await sql<CoordPresenceDbRow[]>`
    SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
           cp.intent, cp.current_plan_slug, cp.current_files,
           cp.host, cp.pid, cp.started_at, cp.heartbeat_at,
           pus.user_id, pus.revoked_at
      FROM harness_shared.coord_presence cp
      LEFT JOIN harness_shared.power_user_sessions pus
        ON pus.auth_session_id = cp.owner_id
     WHERE cp.owner_id = ${ownerId}
  `;
  return rows.length > 0 ? toRecord(rows[0], Date.now()) : null;
}
