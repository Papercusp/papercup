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
