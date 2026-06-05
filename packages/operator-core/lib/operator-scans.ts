/**
 * harness_shared.operator_scans helpers.
 *
 * Persists every Operator scan (success or error) so the Scan History
 * tab in the operator panel can show the past N. The latest row is
 * the same content `last-scan.json` carries; this table adds history.
 *
 * Server-only — file imports sync-sse which opens PG LISTEN. The
 * `server-only` import below is enforced by Next so any client-bundle
 * leak fails compile rather than crashing dev at render time (see the
 * duplicate-dashboard incident in docs/duplicate-dashboard-report-2026-05-12.md).
 *
 * Any client-side caller must go through `/api/agent-mcp/operator-scans`
 * (HTTP) instead of importing this module directly.
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
import { notifySyncInvalidate } from './sync-sse';

export interface OperatorScanRow {
  id: number;
  workspaceId: string;
  startedAt: string;        // ISO
  endedAt: string | null;
  agentSessionId: string | null;
  requestText: string | null;
  summary: string | null;
  suggestions: any[];
  suggestionCount: number;
  costUsd: number;
  cached: boolean;
  error: string | null;
}

interface InsertScanArgs {
  workspaceId: string;
  startedAt: Date;
  requestText: string | null;
  agentSessionId?: string | null;
}

interface CompleteScanArgs {
  id: number;
  endedAt: Date;
  summary: string | null;
  suggestions: any[];
  costUsd: number;
  cached?: boolean;
  agentSessionId?: string | null;
}

interface FailScanArgs {
  id: number;
  endedAt: Date;
  error: string;
}

/**
 * Insert a "started" row at scan kickoff. Returns the id so the
 * caller can finalize via completeOperatorScan() or failOperatorScan()
 * when the SSE stream finishes (or errors).
 */
export async function startOperatorScan(args: InsertScanArgs): Promise<number> {
  const id = await withWorkspace(args.workspaceId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO harness_shared.operator_scans (
        workspace_id, started_at, request_text, agent_session_id
      ) VALUES (
        ${args.workspaceId},
        ${args.startedAt.toISOString()},
        ${args.requestText},
        ${args.agentSessionId ?? null}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  });
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
  return id;
}

export async function completeOperatorScan(args: CompleteScanArgs): Promise<void> {
  // By-id finalize: the id is unique across workspaces, so this targets exactly
  // one row regardless of workspace. Run via the admin handle (rolbypassrls) — a
  // withWorkspace() update would be RLS-scoped to one workspace (P-062 Phase 2),
  // so finalizing a non-default-workspace scan would silently match 0 rows.
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.operator_scans SET
      ended_at         = ${args.endedAt.toISOString()},
      summary          = ${args.summary},
      suggestions      = ${JSON.stringify(args.suggestions)}::text::jsonb,
      suggestion_count = ${args.suggestions.length},
      cost_usd         = ${args.costUsd},
      cached           = ${args.cached ?? false},
      agent_session_id = COALESCE(${args.agentSessionId ?? null}, agent_session_id)
    WHERE id = ${args.id}
  `;
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
}

export async function failOperatorScan(args: FailScanArgs): Promise<void> {
  // By-id finalize via the admin handle — see completeOperatorScan().
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.operator_scans SET
      ended_at = ${args.endedAt.toISOString()},
      error    = ${args.error}
    WHERE id = ${args.id}
  `;
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
}

export async function listOperatorScans(opts: {
  workspaceId: string;
  limit?: number;
}): Promise<OperatorScanRow[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, agent_session_id,
        request_text, summary, suggestions, suggestion_count,
        cost_usd, cached, error
      FROM harness_shared.operator_scans
      WHERE workspace_id = ${opts.workspaceId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toRow);
  });
}

export async function searchOperatorScans(opts: {
  workspaceId: string;
  query: string;
  limit?: number;
}): Promise<OperatorScanRow[]> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const needle = `%${opts.query.replace(/[%_]/g, (c) => '\\' + c)}%`;
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, agent_session_id,
        request_text, summary, suggestions, suggestion_count,
        cost_usd, cached, error
      FROM harness_shared.operator_scans
      WHERE workspace_id = ${opts.workspaceId}
        AND (
             COALESCE(summary, '')      ILIKE ${needle}
          OR COALESCE(request_text, '') ILIKE ${needle}
          OR suggestions::text          ILIKE ${needle}
        )
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toRow);
  });
}

export async function getOperatorScan(opts: {
  workspaceId: string;
  id: number;
}): Promise<OperatorScanRow | null> {
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, agent_session_id,
        request_text, summary, suggestions, suggestion_count,
        cost_usd, cached, error
      FROM harness_shared.operator_scans
      WHERE id = ${opts.id} AND workspace_id = ${opts.workspaceId}
      LIMIT 1
    `;
    return rows.length ? toRow(rows[0]) : null;
  });
}

function toRow(r: any): OperatorScanRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    endedAt: r.ended_at ? (r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at) : null,
    agentSessionId: r.agent_session_id ?? null,
    requestText: r.request_text ?? null,
    summary: r.summary ?? null,
    suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
    suggestionCount: Number(r.suggestion_count ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    cached: !!r.cached,
    error: r.error ?? null,
  };
}
