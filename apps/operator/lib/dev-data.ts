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

import { getOrgPg } from '@restart/db-org';
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

export interface TelemetryRollupInput {
  workspaceIds: string[] | null;
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
  type Row = { version: string; total: number; active: number; idle: number };
  const rows = (await sql`
    SELECT
      version() AS version,
      count(*)::int AS total,
      count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE state = 'idle')::int AS idle
    FROM pg_stat_activity
    WHERE datname = current_database()
  `) as Row[];
  const r = rows[0];
  return {
    version: r?.version ?? 'unknown',
    totalConnections: r?.total ?? 0,
    activeConnections: r?.active ?? 0,
    idleConnections: r?.idle ?? 0,
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
        fs.statSync(path.join(cur, '.next'));
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

  const prodNext = path.join(operatorDir, '.next');

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
