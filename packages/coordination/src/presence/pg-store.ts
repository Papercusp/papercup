/**
 * pg-store.ts — PgPresenceStore: the production presence store over an
 * injected postgres-js handle.
 *
 * The SQL is kept VERBATIM from the operator's original presence.ts
 * (schema-qualified `harness_shared.coord_presence` + the
 * `power_user_sessions` roster LEFT JOIN) — zero behavior change, and no
 * schema-qualified-identifier interpolation (the hazard the rate-limit
 * extraction flagged). The two host couplings are injected: the org PG
 * handle (`getSql`) and the table bootstrap (`ensureSchema`). A
 * different schema is a sibling store satisfying `PresenceStore`, not a
 * config knob here.
 */

import type { Sql } from 'postgres';
import {
  PRESENCE_STALE_MS,
  type PresenceIdentity,
  type PresenceInput,
  type PresenceRecord,
  type PresenceStore,
} from '@papercusp/pubsub-substrate/presence';

export interface PgPresenceStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure harness_shared.coord_presence exists before first use. */
  ensureSchema: () => Promise<void>;
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
  last_active_at: string | null;
  agent_role: string | null;
  hive_slug: string | null;
  compaction_limit: number | null;
  context_tokens: number | null;
  context_estimated_at: string | null;
  user_id: string | null;
  revoked_at: string | null;
}

/**
 * Normalize a `current_files` jsonb column to `string[]`. postgres-js
 * returns jsonb as a PARSED array under the binary protocol but as a raw
 * JSON STRING under the text protocol (`prepare: false`, which the org
 * handle uses for cheap cold reconnects) — so we must handle both, or
 * currentFiles silently drops to `[]`. (The pre-extraction presence.ts
 * only handled the array case; the dual-impl conformance suite caught it.)
 */
function parseFiles(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(r: CoordPresenceDbRow, now: number): PresenceRecord {
  const files = parseFiles(r.current_files);
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
    lastActiveAt: r.last_active_at,
    agentRole: r.agent_role,
    hiveSlug: r.hive_slug,
    compactionLimit: r.compaction_limit,
    contextTokens: r.context_tokens,
    contextEstimatedAt: r.context_estimated_at,
    stale: now - new Date(r.heartbeat_at).getTime() > PRESENCE_STALE_MS,
    userId: r.user_id,
    revoked: r.revoked_at != null,
  };
}

export class PgPresenceStore implements PresenceStore {
  constructor(private readonly opts: PgPresenceStoreOptions) {}

  async write(identity: PresenceIdentity, input: PresenceInput = {}): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // A declared write IS genuine activity, so bump last_active_at + heartbeat.
    // agent_role / hive_slug are populate-once-then-keep: COALESCE(EXCLUDED, existing)
    // so a write that omits them (passes null) never WIPES a previously-resolved
    // value (D-004).
    await sql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent,
         current_plan_slug, current_files, host, pid,
         agent_role, hive_slug, heartbeat_at, last_active_at)
      VALUES (
        ${identity.ownerId}, ${identity.ownerLabel},
        ${identity.workspaceId ?? 'default'}, ${identity.source},
        ${input.intent ?? ''}, ${input.currentPlanSlug ?? null},
        ${JSON.stringify(input.currentFiles ?? [])}::text::jsonb,
        ${input.host ?? ''}, ${input.pid ?? null},
        ${input.agentRole ?? null}, ${input.hiveSlug ?? null}, now(), now()
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
        agent_role        = COALESCE(EXCLUDED.agent_role, harness_shared.coord_presence.agent_role),
        hive_slug         = COALESCE(EXCLUDED.hive_slug, harness_shared.coord_presence.hive_slug),
        heartbeat_at      = now(),
        last_active_at    = now()
    `;
  }

  async touchHeartbeat(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // KEEPALIVE only — never bumps last_active_at (D-003): the 60s supervisor
    // beat keeps the process "alive" without implying activity.
    await sql`
      UPDATE harness_shared.coord_presence
         SET heartbeat_at = now()
       WHERE owner_id = ${ownerId}
    `;
  }

  async touchActivity(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // ACTIVITY path (e.g. tool dispatch) — bumps last_active_at AND heartbeat
    // (D-003). No-op when no row exists, like touchHeartbeat.
    await sql`
      UPDATE harness_shared.coord_presence
         SET heartbeat_at = now(), last_active_at = now()
       WHERE owner_id = ${ownerId}
    `;
  }

  async setCompactionLimit(ownerId: string, limit: number): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Per-session SOFT compaction target in tokens (agent-managed-compaction-2026-07-01).
    // No-op when no row exists, like touchHeartbeat / touchActivity.
    await sql`
      UPDATE harness_shared.coord_presence
         SET compaction_limit = ${limit}
       WHERE owner_id = ${ownerId}
    `;
  }

  async setContextEstimate(ownerId: string, tokens: number): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Cached context-size estimate (agent-managed-compaction P-007/P-009) — written
    // by the compaction-compliance watchdog on a cadence, read by the inbox usage
    // signal. No-op when no row exists.
    await sql`
      UPDATE harness_shared.coord_presence
         SET context_tokens = ${tokens}, context_estimated_at = now()
       WHERE owner_id = ${ownerId}
    `;
  }

  async heartbeat(identity: PresenceIdentity): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Create-if-absent (intent/files/plan default empty) + bump heartbeat.
    // A coord:inbox read IS genuine activity (D-003), so this ALSO bumps
    // last_active_at. On conflict, refresh only identity columns + the two
    // timestamps — declared intent/current_files/current_plan_slug/host/pid
    // (and agent_role/hive_slug) are PRESERVED.
    await sql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, heartbeat_at, last_active_at)
      VALUES (
        ${identity.ownerId}, ${identity.ownerLabel},
        ${identity.workspaceId ?? 'default'}, ${identity.source}, now(), now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        owner_label    = EXCLUDED.owner_label,
        workspace_id   = EXCLUDED.workspace_id,
        source         = EXCLUDED.source,
        heartbeat_at   = now(),
        last_active_at = now()
    `;
  }

  async clear(ownerId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      DELETE FROM harness_shared.coord_presence WHERE owner_id = ${ownerId}
    `;
  }

  async list(
    opts: { workspaceId?: string | null; hiveSlug?: string | null } = {},
  ): Promise<PresenceRecord[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const ws = opts.workspaceId ?? null;
    const hive = opts.hiveSlug ?? null;
    const rows = await sql<CoordPresenceDbRow[]>`
      SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
             cp.intent, cp.current_plan_slug, cp.current_files,
             cp.host, cp.pid, cp.started_at, cp.heartbeat_at,
             cp.last_active_at, cp.agent_role, cp.hive_slug, cp.compaction_limit,
             cp.context_tokens, cp.context_estimated_at,
             pus.user_id, pus.revoked_at
        FROM harness_shared.coord_presence cp
        LEFT JOIN harness_shared.power_user_sessions pus
          ON pus.auth_session_id = cp.owner_id
       WHERE ${ws == null ? sql`TRUE` : sql`cp.workspace_id = ${ws}`}
         AND ${hive == null ? sql`TRUE` : sql`cp.hive_slug = ${hive}`}
       ORDER BY cp.owner_id
    `;
    const now = Date.now();
    return rows.map((r) => toRecord(r, now));
  }

  async get(ownerId: string): Promise<PresenceRecord | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<CoordPresenceDbRow[]>`
      SELECT cp.owner_id, cp.owner_label, cp.workspace_id, cp.source,
             cp.intent, cp.current_plan_slug, cp.current_files,
             cp.host, cp.pid, cp.started_at, cp.heartbeat_at,
             cp.last_active_at, cp.agent_role, cp.hive_slug, cp.compaction_limit,
             cp.context_tokens, cp.context_estimated_at,
             pus.user_id, pus.revoked_at
        FROM harness_shared.coord_presence cp
        LEFT JOIN harness_shared.power_user_sessions pus
          ON pus.auth_session_id = cp.owner_id
       WHERE cp.owner_id = ${ownerId}
    `;
    return rows.length > 0 ? toRecord(rows[0], Date.now()) : null;
  }

  async sweepStale(maxAgeMs: number): Promise<number> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const secs = Math.max(1, Math.floor(maxAgeMs / 1000));
    // Interval bound as a text param + cast — the getOrgPg client serializes
    // jsonb/object params oppositely to a fresh pool, but a plain text interval
    // is safe either way.
    const rows = await sql<{ owner_id: string }[]>`
      DELETE FROM harness_shared.coord_presence
       WHERE heartbeat_at < now() - ${`${secs} seconds`}::interval
      RETURNING owner_id
    `;
    return rows.length;
  }
}

/**
 * Bootstrap `harness_shared.coord_presence` for tests / fresh test rigs —
 * the presence analog of `ensureCoordEventLogTable`. The CREATE mirrors
 * `000-baseline.sql`; the `ADD COLUMN IF NOT EXISTS` block mirrors the
 * presence-v2 migration (`277-coord-presence-v2-columns.sql`) so a table left
 * over from before those columns existed (the `getTestPg` container is reused
 * across files AND runs) is migrated IN PLACE rather than left stale. This is
 * the one place the test schema is defined, kept beside the `PgPresenceStore`
 * SQL that consumes it — so a new column the store reads is added HERE in the
 * same change, never re-drifting across hand-rolled per-test DDL (the recurring
 * "column does not exist" failure class). Pre-alpha, test-only: no production
 * data on this path, so the in-place column add is safe.
 *
 * Production schema is owned by the migrations; this never runs there.
 */
export async function ensureCoordPresenceTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
      owner_id          text        NOT NULL PRIMARY KEY,
      owner_label       text        NOT NULL DEFAULT '',
      workspace_id      text        NOT NULL DEFAULT 'default',
      source            text        NOT NULL DEFAULT '',
      intent            text        NOT NULL DEFAULT '',
      current_plan_slug text,
      current_files     jsonb       NOT NULL DEFAULT '[]'::jsonb,
      host              text        NOT NULL DEFAULT '',
      pid               integer,
      started_at        timestamptz NOT NULL DEFAULT now(),
      heartbeat_at      timestamptz NOT NULL DEFAULT now(),
      last_active_at    timestamptz,
      agent_role        text,
      hive_slug         text,
      compaction_limit  integer,
      context_tokens    integer,
      context_estimated_at timestamptz
    )
  `;
  // presence-v2 (migration 277) columns the store reads/writes — added in place
  // for a pre-v2 table left in the reused test container.
  await sql`
    ALTER TABLE harness_shared.coord_presence
      ADD COLUMN IF NOT EXISTS last_active_at   timestamptz,
      ADD COLUMN IF NOT EXISTS agent_role       text,
      ADD COLUMN IF NOT EXISTS hive_slug        text,
      ADD COLUMN IF NOT EXISTS compaction_limit integer,
      ADD COLUMN IF NOT EXISTS context_tokens   integer,
      ADD COLUMN IF NOT EXISTS context_estimated_at timestamptz
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.power_user_sessions (
      auth_session_id TEXT        NOT NULL PRIMARY KEY,
      workspace_id    TEXT        NOT NULL,
      user_id         TEXT        NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at      TIMESTAMPTZ
    )
  `;
}
