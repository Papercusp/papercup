/**
 * Cross-workspace data API for the /dev page.
 *
 * Function-of-truth for both:
 *   - GET /api/agent-tools/dev/* MCP tools
 *   - Future HTTP routes if we add any
 *
 * Iterates the workspace registry (~/.papercusp-workspaces/registry.json)
 * and fans out to per-workspace state. workspaceIds=null means "all".
 */

import { getOrgPg } from '@papercusp/db-org';

/**
 * Build a transport WHERE-fragment for tool_invocations queries.
 * Composes via postgres-js fragment templating so a caller can splice
 * `${tFilter}` into a larger SQL template. Returns `sql\`\`` (empty)
 * when no filter applies — safe to inline.
 *
 * 'unknown' matches NULL rows (pre-058 invocations).
 */
function buildTransportFilter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any,
  transports: TransportFilter[] | null | undefined,
): unknown {
  if (!transports) return sql``;
  if (transports.length === 0) {
    // Caller asked for no rows. Returning `1=0` is the safest way to
    // make every row match nothing without restructuring the caller.
    return sql`AND 1=0`;
  }
  const includesUnknown = transports.includes('unknown');
  const named = transports.filter((t) => t !== 'unknown') as Exclude<TransportFilter, 'unknown'>[];
  if (includesUnknown && named.length === 0) {
    return sql`AND transport IS NULL`;
  }
  if (includesUnknown) {
    return sql`AND (transport = ANY(${named}) OR transport IS NULL)`;
  }
  return sql`AND transport = ANY(${named})`;
}
import { getHealth, type HealthData } from './harness-readers';
import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { readRegistry as readWorkspaceRegistry, type WorkspaceEntry } from './workspace-registry';

export interface HarnessAcross {
  slug: string;
  path: string;
  workspaceId: string;
  workspaceName: string;
  harness_kind?: string;
  health?: HealthData | null;
  healthError?: string;
}

function selectWorkspaces(workspaceIds: string[] | null): WorkspaceEntry[] {
  const reg = readWorkspaceRegistry();
  if (workspaceIds === null) return reg.workspaces;
  const want = new Set(workspaceIds);
  return reg.workspaces.filter((w) => want.has(w.id));
}

export async function listAllHarnesses(
  workspaceIds: string[] | null,
): Promise<{ harnesses: Omit<HarnessAcross, 'health' | 'healthError'>[] }> {
  const workspaces = selectWorkspaces(workspaceIds);
  const out: Omit<HarnessAcross, 'health' | 'healthError'>[] = [];
  for (const ws of workspaces) {
    const reg = await loadHarnessRegistry(ws.id);
    for (const p of reg.projects) {
      out.push({
        slug: p.slug,
        path: p.path,
        harness_kind: p.harness_kind,
        workspaceId: ws.id,
        workspaceName: ws.name || ws.id,
      });
    }
  }
  return { harnesses: out };
}

export async function listAllHarnessesWithHealth(
  workspaceIds: string[] | null,
): Promise<{ harnesses: HarnessAcross[] }> {
  const { harnesses: bases } = await listAllHarnesses(workspaceIds);
  const enriched = await Promise.all(
    bases.map(async (h) => {
      const project: ProjectEntry = { slug: h.slug, path: h.path };
      const result = await getHealth(h.slug, { project });
      if (!result.ok) {
        return { ...h, healthError: result.error, health: null };
      }
      return { ...h, health: result.data };
    }),
  );
  return { harnesses: enriched };
}

// ── Tool-invocation telemetry rollup ───────────────────────────────

export interface TelemetryRollupEntry {
  tool_name: string;
  call_count: number;
  error_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  workspaces: string[];
}

/** Transport filter values for /dev → Sessions / Telemetry. 'unknown'
 *  matches NULL rows from before migration 058 added the column. */
export type TransportFilter = 'http' | 'mcp' | 'ipc' | 'in_process' | 'unknown';

export interface TelemetryRollupInput {
  workspaceIds: string[] | null;
  /** When set, restrict to rows whose transport column matches one of
   *  these. 'unknown' matches NULL. Empty array means "no rows". */
  transports?: TransportFilter[] | null;
  hours?: number;
  limit?: number;
}

export async function telemetryRollup(
  input: TelemetryRollupInput,
): Promise<{ entries: TelemetryRollupEntry[] }> {
  const hours = Math.max(1, Math.min(168, input.hours ?? 24));
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const { sql } = getOrgPg();
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const wsFilter = input.workspaceIds && input.workspaceIds.length > 0;
  const tFilter = buildTransportFilter(sql, input.transports);

  type Row = {
    tool_name: string;
    call_count: number;
    error_count: number;
    p50: number | null;
    p95: number | null;
    workspaces: string[];
  };
  const rows = wsFilter
    ? ((await sql`
        SELECT
          tool_name,
          count(*)::int AS call_count,
          count(*) FILTER (WHERE status != 'ok')::int AS error_count,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
          array_agg(DISTINCT workspace_id) AS workspaces
        FROM harness_shared.tool_invocations
        WHERE invoked_at > ${sinceIso}::timestamptz
          AND workspace_id = ANY(${input.workspaceIds!})
          ${tFilter}
        GROUP BY tool_name
        ORDER BY call_count DESC
        LIMIT ${limit}
      `) as Row[])
    : ((await sql`
        SELECT
          tool_name,
          count(*)::int AS call_count,
          count(*) FILTER (WHERE status != 'ok')::int AS error_count,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
          array_agg(DISTINCT workspace_id) AS workspaces
        FROM harness_shared.tool_invocations
        WHERE invoked_at > ${sinceIso}::timestamptz
          ${tFilter}
        GROUP BY tool_name
        ORDER BY call_count DESC
        LIMIT ${limit}
      `) as Row[]);

  return {
    entries: rows.map((r) => ({
      tool_name: r.tool_name,
      call_count: r.call_count,
      error_count: r.error_count,
      p50_ms: r.p50 == null ? null : Math.round(r.p50),
      p95_ms: r.p95 == null ? null : Math.round(r.p95),
      workspaces: r.workspaces ?? [],
    })),
  };
}

// ── Cross-workspace audit feed ─────────────────────────────────────

export interface AuditEntry {
  id: string;
  ts: number;
  workspace_id: string;
  actor: string | null;
  action: string;
  subject: string | null;
  details: unknown;
}

export interface AuditFeedInput {
  workspaceIds: string[] | null;
  hours?: number;
  limit?: number;
}

export async function auditFeed(
  input: AuditFeedInput,
): Promise<{ entries: AuditEntry[] }> {
  const hours = Math.max(1, Math.min(720, input.hours ?? 24));
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const { sql } = getOrgPg();
  const sinceMs = Date.now() - hours * 3600 * 1000;

  const wsFilter = input.workspaceIds && input.workspaceIds.length > 0;

  type Row = { id: string; ts: string | number; workspace_id: string; actor: string | null; action: string; subject: string | null; details: unknown };
  const rows = wsFilter
    ? ((await sql`
        SELECT id, ts, workspace_id, actor, action, subject, details
        FROM harness_shared.audit_log
        WHERE ts > ${sinceMs}
          AND workspace_id = ANY(${input.workspaceIds!})
        ORDER BY ts DESC
        LIMIT ${limit}
      `) as Row[])
    : ((await sql`
        SELECT id, ts, workspace_id, actor, action, subject, details
        FROM harness_shared.audit_log
        WHERE ts > ${sinceMs}
        ORDER BY ts DESC
        LIMIT ${limit}
      `) as Row[]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      ts: typeof r.ts === 'bigint' ? Number(r.ts) : Number(r.ts),
      workspace_id: r.workspace_id,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      details: r.details,
    })),
  };
}

// ── Cross-workspace session list ───────────────────────────────────

export interface SessionEntry {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  harness_slug: string | null;
  role: string | null;
  run_id: string | null;
  started_at: string;
  ended_at: string;
  tool_count: number;
  error_count: number;
  total_duration_ms: number;
}

export interface SessionListInput {
  workspaceIds: string[] | null;
  /** Transport filter. See TelemetryRollupInput.transports for shape. */
  transports?: TransportFilter[] | null;
  hours?: number;
  limit?: number;
}

export async function listSessions(
  input: SessionListInput,
): Promise<{ entries: SessionEntry[] }> {
  const hours = Math.max(1, Math.min(720, input.hours ?? 24));
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const { sql } = getOrgPg();
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const wsFilter = input.workspaceIds && input.workspaceIds.length > 0;
  const tFilter = buildTransportFilter(sql, input.transports);

  type Row = {
    spawn_id: string;
    parent_spawn_id: string | null;
    workspace_id: string;
    harness_slug: string | null;
    role: string | null;
    run_id: string | null;
    started_at: string;
    ended_at: string;
    tool_count: number;
    error_count: number;
    total_duration_ms: number;
  };
  const rows = wsFilter
    ? ((await sql`
        SELECT
          spawn_id,
          MAX(parent_spawn_id) AS parent_spawn_id,
          MAX(workspace_id) AS workspace_id,
          MAX(harness_slug) AS harness_slug,
          MAX(role) AS role,
          MAX(run_id) AS run_id,
          MIN(invoked_at) AS started_at,
          MAX(invoked_at) AS ended_at,
          count(*)::int AS tool_count,
          count(*) FILTER (WHERE status != 'ok')::int AS error_count,
          COALESCE(SUM(duration_ms), 0)::int AS total_duration_ms
        FROM harness_shared.tool_invocations
        WHERE invoked_at > ${sinceIso}::timestamptz
          AND workspace_id = ANY(${input.workspaceIds!})
          AND spawn_id IS NOT NULL
          ${tFilter}
        GROUP BY spawn_id
        ORDER BY started_at DESC
        LIMIT ${limit}
      `) as Row[])
    : ((await sql`
        SELECT
          spawn_id,
          MAX(parent_spawn_id) AS parent_spawn_id,
          MAX(workspace_id) AS workspace_id,
          MAX(harness_slug) AS harness_slug,
          MAX(role) AS role,
          MAX(run_id) AS run_id,
          MIN(invoked_at) AS started_at,
          MAX(invoked_at) AS ended_at,
          count(*)::int AS tool_count,
          count(*) FILTER (WHERE status != 'ok')::int AS error_count,
          COALESCE(SUM(duration_ms), 0)::int AS total_duration_ms
        FROM harness_shared.tool_invocations
        WHERE invoked_at > ${sinceIso}::timestamptz
          AND spawn_id IS NOT NULL
          ${tFilter}
        GROUP BY spawn_id
        ORDER BY started_at DESC
        LIMIT ${limit}
      `) as Row[]);

  return { entries: rows };
}

// ── Activity feed: most-recent tool invocations across workspaces ──

export interface ActivityEntry {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  tool_name: string;
  role: string | null;
  spawn_id: string | null;
  invoked_at: string;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
}

export interface ActivityFeedInput {
  workspaceIds: string[] | null;
  limit?: number;
}

export async function activityFeed(
  input: ActivityFeedInput,
): Promise<{ entries: ActivityEntry[] }> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 50));
  const { sql } = getOrgPg();
  const wsFilter = input.workspaceIds && input.workspaceIds.length > 0;

  type Row = {
    id: string;
    workspace_id: string;
    harness_slug: string | null;
    tool_name: string;
    role: string | null;
    spawn_id: string | null;
    invoked_at: string;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
  };

  const rows = wsFilter
    ? ((await sql`
        SELECT id::text, workspace_id, harness_slug, tool_name, role, spawn_id, invoked_at, duration_ms, status, error_message
        FROM harness_shared.tool_invocations
        WHERE workspace_id = ANY(${input.workspaceIds!})
        ORDER BY invoked_at DESC
        LIMIT ${limit}
      `) as Row[])
    : ((await sql`
        SELECT id::text, workspace_id, harness_slug, tool_name, role, spawn_id, invoked_at, duration_ms, status, error_message
        FROM harness_shared.tool_invocations
        ORDER BY invoked_at DESC
        LIMIT ${limit}
      `) as Row[]);

  return { entries: rows };
}

// ── PG stats ───────────────────────────────────────────────────────

export interface PgHealth {
  version: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  /** Server-wide `max_connections` ceiling. */
  maxConnections: number;
  /** Backends across ALL databases — this is what counts against `max_connections`
   *  (e.g. the su-lock pool lives in `papercusp_su` but shares the same instance). */
  serverWideConnections: number;
  /** serverWideConnections / maxConnections, 0–100. >~85 is the danger zone. */
  saturationPct: number;
  /** Top connection holders by `application_name`, server-wide — the attribution
   *  the 2026-06-17 exhaustion incident lacked. `(unset)` = an untagged pool. */
  byApplication: { name: string; count: number }[];
}

export interface PgActiveQuery {
  pid: number;
  state: string | null;
  query: string;
  duration_seconds: number;
  application_name: string | null;
  client_addr: string | null;
}

export interface PgTableSize {
  schema: string;
  table: string;
  total_bytes: number;
  index_bytes: number;
  rows_estimate: number | null;
}

export async function pgHealth(): Promise<PgHealth> {
  const { sql } = getOrgPg();
  type Row = {
    version: string;
    total: number;
    active: number;
    idle: number;
    server_wide: number;
    max_conn: number;
  };
  const rows = (await sql`
    SELECT
      version() AS version,
      count(*) FILTER (WHERE datname = current_database())::int AS total,
      count(*) FILTER (WHERE datname = current_database() AND state = 'active')::int AS active,
      count(*) FILTER (WHERE datname = current_database() AND state = 'idle')::int AS idle,
      count(*)::int AS server_wide,
      current_setting('max_connections')::int AS max_conn
    FROM pg_stat_activity
  `) as Row[];
  const r = rows[0];
  type AppRow = { name: string; count: number };
  const apps = (await sql`
    SELECT coalesce(nullif(application_name, ''), '(unset)') AS name, count(*)::int AS count
    FROM pg_stat_activity
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 20
  `) as AppRow[];
  const maxConnections = r?.max_conn ?? 0;
  const serverWide = r?.server_wide ?? 0;
  return {
    version: r?.version ?? 'unknown',
    totalConnections: r?.total ?? 0,
    activeConnections: r?.active ?? 0,
    idleConnections: r?.idle ?? 0,
    maxConnections,
    serverWideConnections: serverWide,
    saturationPct: maxConnections > 0 ? Math.round((serverWide / maxConnections) * 1000) / 10 : 0,
    byApplication: apps.map((a) => ({ name: a.name, count: a.count })),
  };
}

export async function pgActiveQueries(limit = 50): Promise<{ queries: PgActiveQuery[] }> {
  const { sql } = getOrgPg();
  const lim = Math.max(1, Math.min(200, limit));
  type Row = {
    pid: number;
    state: string | null;
    query: string;
    duration_seconds: number;
    application_name: string | null;
    client_addr: string | null;
  };
  const rows = (await sql`
    SELECT
      pid,
      state,
      query,
      EXTRACT(EPOCH FROM (now() - query_start))::float AS duration_seconds,
      application_name,
      client_addr::text AS client_addr
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND query NOT ILIKE '%pg_stat_activity%'
      AND state IS NOT NULL
    ORDER BY query_start ASC NULLS LAST
    LIMIT ${lim}
  `) as Row[];
  return { queries: rows };
}

export async function pgTableSizes(
  schema = 'harness_shared',
  limit = 50,
): Promise<{ tables: PgTableSize[] }> {
  const { sql } = getOrgPg();
  const lim = Math.max(1, Math.min(500, limit));
  type Row = {
    schema: string;
    table: string;
    total_bytes: string;
    index_bytes: string;
    rows_estimate: number | null;
  };
  const rows = (await sql`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      pg_total_relation_size(c.oid)::bigint AS total_bytes,
      pg_indexes_size(c.oid)::bigint AS index_bytes,
      CASE WHEN c.reltuples > 0 THEN c.reltuples::bigint ELSE NULL END AS rows_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = ${schema}
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT ${lim}
  `) as Row[];
  return {
    tables: rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      total_bytes: Number(r.total_bytes),
      index_bytes: Number(r.index_bytes),
      rows_estimate: r.rows_estimate == null ? null : Number(r.rows_estimate),
    })),
  };
}

// ── Build status (filesystem inspection) ───────────────────────────

export interface BuildStatus {
  /** Has a prod .next build directory + when was it last modified */
  prodBuild: { exists: boolean; mtimeMs: number | null };
  /** Has a dev .next directory + when */
  devBuild: { exists: boolean; mtimeMs: number | null };
  /** Recent bin/prod.log tail (last 4KB) — useful for spotting build errors. */
  prodLogTail: string | null;
  /** Whether the dev server (3055) and prod server (3070) are reachable. */
  dev3055Reachable: boolean | null;
  prod3070Reachable: boolean | null;
}

export async function buildStatus(): Promise<BuildStatus> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // In Next dev/prod, the server runs with cwd=apps/operator. .next sits
  // right there. For other launch shapes (tauri shell, standalone), we
  // walk up looking for a folder that has both `.next` and `package.json`.
  function findOperatorRoot(start: string): string {
    let cur = start;
    for (let i = 0; i < 5; i++) {
      try {
        fs.statSync(path.join(/*turbopackIgnore: true*/ cur, '.next'));
        return cur;
      } catch {
        /* not here */
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return start;
  }
  const operatorDir = findOperatorRoot(process.cwd());

  function mtime(p: string): number | null {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  }

  const prodNext = path.join(/*turbopackIgnore: true*/ operatorDir, '.next');

  // bin/prod log paths — try a few common locations.
  const workspaceRoot = path.resolve(operatorDir, '..', '..');
  const candidates = [
    path.join(workspaceRoot, 'bin-prod.log'),
    path.join(workspaceRoot, 'papercup-rust-server.log'),
    path.join(workspaceRoot, 'cp.log'),
  ];
  let prodLogTail: string | null = null;
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      const fd = fs.openSync(c, 'r');
      try {
        const tailBytes = Math.min(4096, stat.size);
        const buf = Buffer.alloc(tailBytes);
        fs.readSync(fd, buf, 0, tailBytes, Math.max(0, stat.size - tailBytes));
        prodLogTail = buf.toString('utf8');
        break;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* try next */
    }
  }

  async function reachable(url: string): Promise<boolean> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      return r.status < 500;
    } catch {
      return false;
    }
  }
  const [dev3055, prod3070] = await Promise.all([
    reachable('http://127.0.0.1:3055/'),
    reachable('http://127.0.0.1:3070/'),
  ]);

  return {
    prodBuild: { exists: !!mtime(prodNext), mtimeMs: mtime(prodNext) },
    devBuild: { exists: !!mtime(prodNext), mtimeMs: mtime(prodNext) },
    prodLogTail,
    dev3055Reachable: dev3055,
    prod3070Reachable: prod3070,
  };
}

// ── Session drilldown ──────────────────────────────────────────────

export interface SessionAgent {
  spawn_id: string;
  workspace_id: string;
  harness_slug: string | null;
  parent_spawn_id: string | null;
  parent_role: string | null;
  child_role: string | null;
  feature_id: string | null;
  chunk_id: string | null;
  run_id: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  output_tail: string | null;
  error_message: string | null;
  cancel_requested: boolean | null;
}

export interface SessionInvocation {
  id: string;
  tool_name: string;
  invoked_at: string;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  args_json: unknown;
}

export interface SessionChildSpawn {
  spawn_id: string;
  child_role: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  tool_count: number;
  error_count: number;
}

export interface SessionDetail {
  spawn_id: string;
  agent: SessionAgent | null;
  invocations: SessionInvocation[];
  children: SessionChildSpawn[];
  related_chats: Array<{ id: string; role: string; title: string | null; updated_at: string }>;
}

export async function getSessionDetail(spawnId: string): Promise<SessionDetail | null> {
  const { sql } = getOrgPg();

  // 1. spawned_agents row.
  type AgentRow = {
    spawn_id: string;
    workspace_id: string;
    harness_slug: string | null;
    parent_spawn_id: string | null;
    parent_role: string | null;
    child_role: string | null;
    feature_id: string | null;
    chunk_id: string | null;
    run_id: string | null;
    status: string | null;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    exit_code: number | null;
    output_tail: string | null;
    error_message: string | null;
    cancel_requested: boolean | null;
  };
  const agentRows = (await sql`
    SELECT * FROM harness_shared.spawned_agents
    WHERE spawn_id = ${spawnId}
    LIMIT 1
  `) as AgentRow[];
  const agent = agentRows[0] ?? null;

  // 2. tool_invocations for this spawn (timeline).
  type InvocRow = {
    id: string;
    tool_name: string;
    invoked_at: string;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    args_json: unknown;
  };
  const invocations = (await sql`
    SELECT id::text, tool_name, invoked_at, duration_ms, status, error_message, args_json
    FROM harness_shared.tool_invocations
    WHERE spawn_id = ${spawnId}
    ORDER BY invoked_at ASC
    LIMIT 500
  `) as InvocRow[];

  // 3. Children: spawns whose parent_spawn_id = this spawn.
  type ChildRow = {
    spawn_id: string;
    child_role: string | null;
    status: string | null;
    started_at: string | null;
    finished_at: string | null;
    tool_count: number;
    error_count: number;
  };
  const children = (await sql`
    SELECT
      sa.spawn_id,
      sa.child_role,
      sa.status,
      sa.started_at,
      sa.finished_at,
      COALESCE(ti.cnt, 0)::int AS tool_count,
      COALESCE(ti.err, 0)::int AS error_count
    FROM harness_shared.spawned_agents sa
    LEFT JOIN (
      SELECT spawn_id,
             count(*)::int AS cnt,
             count(*) FILTER (WHERE status != 'ok')::int AS err
      FROM harness_shared.tool_invocations
      GROUP BY spawn_id
    ) ti ON ti.spawn_id = sa.spawn_id
    WHERE sa.parent_spawn_id = ${spawnId}
    ORDER BY sa.started_at ASC NULLS LAST
    LIMIT 100
  `) as ChildRow[];

  // 4. Related agent_chats — same harness + feature_id, if we have both.
  let relatedChats: Array<{ id: string; role: string; title: string | null; updated_at: string }> = [];
  if (agent && agent.harness_slug && agent.feature_id) {
    try {
      const dbc = (await import('@papercusp/db-org')).getLegacyClient(agent.harness_slug);
      const rows = (await dbc
        .prepare(
          'SELECT id, role, title, updated_at FROM agent_chats WHERE feature_id = ? ORDER BY updated_at DESC LIMIT 20',
        )
        .all(agent.feature_id)) as Array<{
        id: string;
        role: string;
        title: string | null;
        updated_at: unknown;
      }>;
      // agent_chats.updated_at is now bigint epoch-ms (migration 116). Coerce to
      // the ISO string this surface's contract expects (was timestamptz).
      relatedChats = rows.map((r) => ({
        id: r.id,
        role: r.role,
        title: r.title,
        updated_at:
          r.updated_at == null
            ? ''
            : new Date(
                typeof r.updated_at === 'bigint' ? Number(r.updated_at) : Number(r.updated_at),
              ).toISOString(),
      }));
    } catch {
      /* per-harness legacy client unavailable */
    }
  }

  if (!agent && invocations.length === 0 && children.length === 0) {
    return null;
  }

  return {
    spawn_id: spawnId,
    agent,
    invocations,
    children,
    related_chats: relatedChats,
  };
}

// ── Process inventory (proc walk) ──────────────────────────────────

export interface ProcessEntry {
  pid: number;
  kind: 'run.sh' | 'omp' | 'claude' | 'paperclip' | 'pty' | 'next' | 'other';
  cmdline: string;
  cwd: string | null;
  started_seconds_ago: number;
  harness_slug: string | null;
  workspace_id: string | null;
}

const KIND_PATTERNS: Array<{ kind: ProcessEntry['kind']; needles: RegExp }> = [
  { kind: 'run.sh', needles: /autonomous-harness\/run\.sh|\/harness\/run\.sh|orchestrator-run/ },
  { kind: 'omp', needles: /\b(omp|oh-my-pi)\b|\.omp\/agent/ },
  { kind: 'claude', needles: /\.local\/bin\/claude\b|\/claude --output-format|claude-code/ },
  { kind: 'paperclip', needles: /paperclipai/ },
  { kind: 'pty', needles: /\bpty-ws\b|pty-host/ },
  { kind: 'next', needles: /next-server|\.next\/server/ },
];

function classifyKind(cmdline: string): ProcessEntry['kind'] {
  for (const p of KIND_PATTERNS) {
    if (p.needles.test(cmdline)) return p.kind;
  }
  return 'other';
}

export interface ListProcessesInput {
  kinds?: Array<ProcessEntry['kind']>;
}

export async function listProcesses(
  input: ListProcessesInput = {},
): Promise<{ processes: ProcessEntry[] }> {
  const fs = await import('node:fs');
  const want = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;

  // Build path→slug map across all workspaces so we can attribute each
  // proc's cwd to a harness when possible.
  const wsReg = readWorkspaceRegistry();
  const pathToHarness = new Map<string, { slug: string; workspaceId: string }>();
  for (const w of wsReg.workspaces) {
    try {
      const hreg = await loadHarnessRegistry(w.id);
      for (const p of hreg.projects) {
        pathToHarness.set(p.path, { slug: p.slug, workspaceId: w.id });
      }
    } catch {
      /* skip unreadable registry */
    }
  }

  let pids: string[];
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return { processes: [] };
  }

  const now = Date.now();
  const out: ProcessEntry[] = [];

  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline = '';
    try {
      // /proc/<pid>/cmdline separates argv with NUL bytes; convert to spaces.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      cmdline = raw.toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmdline) continue;
    const kind = classifyKind(cmdline);
    if (kind === 'other') continue;
    if (want && !want.has(kind)) continue;

    let cwd: string | null = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* perm-denied */
    }

    let startedMs = 0;
    try {
      startedMs = fs.statSync(`/proc/${pid}`).mtimeMs;
    } catch {
      /* no stat */
    }
    const started_seconds_ago = startedMs > 0 ? Math.floor((now - startedMs) / 1000) : 0;

    let harness_slug: string | null = null;
    let workspace_id: string | null = null;
    if (cwd) {
      for (const [hpath, ref] of pathToHarness) {
        if (cwd === hpath || cwd.startsWith(hpath + '/')) {
          harness_slug = ref.slug;
          workspace_id = ref.workspaceId;
          break;
        }
      }
    }

    out.push({
      pid: Number(pid),
      kind,
      cmdline: cmdline.slice(0, 240),
      cwd,
      started_seconds_ago,
      harness_slug,
      workspace_id,
    });
  }

  out.sort((a, b) => a.started_seconds_ago - b.started_seconds_ago);
  return { processes: out };
}
