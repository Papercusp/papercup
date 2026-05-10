/**
 * harness_shared.operator_scans helpers.
 *
 * Persists every Operator scan (success or error) so the Scan History
 * tab in the operator panel can show the past N. The latest row is
 * the same content `last-scan.json` carries; this table adds history.
 *
 * Server-only.
 */
import { withWorkspace } from '@restart/db-org';
import { ensureOperatorScansTable } from './ensure-schema';
import { notifySyncInvalidate } from './sync-sse';
import { DEFAULT_WORKSPACE_ID } from './workspace-registry';

export interface OperatorScanRow {
  id: number;
  workspaceId: string;
  startedAt: string;        // ISO
  endedAt: string | null;
  claudeSessionId: string | null;
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
  claudeSessionId?: string | null;
}

interface CompleteScanArgs {
  id: number;
  endedAt: Date;
  summary: string | null;
  suggestions: any[];
  costUsd: number;
  cached?: boolean;
  claudeSessionId?: string | null;
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
  await ensureOperatorScansTable();
  const id = await withWorkspace(args.workspaceId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO harness_shared.operator_scans (
        workspace_id, started_at, request_text, claude_session_id
      ) VALUES (
        ${args.workspaceId},
        ${args.startedAt.toISOString()},
        ${args.requestText},
        ${args.claudeSessionId ?? null}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  });
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
  return id;
}

export async function completeOperatorScan(args: CompleteScanArgs): Promise<void> {
  await ensureOperatorScansTable();
  // Resolve workspace from the row itself rather than asking the caller —
  // the id is unique across workspaces.
  await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    await tx`
      UPDATE harness_shared.operator_scans SET
        ended_at         = ${args.endedAt.toISOString()},
        summary          = ${args.summary},
        suggestions      = ${JSON.stringify(args.suggestions)}::jsonb,
        suggestion_count = ${args.suggestions.length},
        cost_usd         = ${args.costUsd},
        cached           = ${args.cached ?? false},
        claude_session_id = COALESCE(${args.claudeSessionId ?? null}, claude_session_id)
      WHERE id = ${args.id}
    `;
  });
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
}

export async function failOperatorScan(args: FailScanArgs): Promise<void> {
  await ensureOperatorScansTable();
  await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    await tx`
      UPDATE harness_shared.operator_scans SET
        ended_at = ${args.endedAt.toISOString()},
        error    = ${args.error}
      WHERE id = ${args.id}
    `;
  });
  void notifySyncInvalidate('operatorScans.running').catch(() => {});
}

export async function listOperatorScans(opts: {
  workspaceId: string;
  limit?: number;
}): Promise<OperatorScanRow[]> {
  await ensureOperatorScansTable();
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, claude_session_id,
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
  await ensureOperatorScansTable();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const needle = `%${opts.query.replace(/[%_]/g, (c) => '\\' + c)}%`;
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, claude_session_id,
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
  await ensureOperatorScansTable();
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      SELECT
        id, workspace_id, started_at, ended_at, claude_session_id,
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
    claudeSessionId: r.claude_session_id ?? null,
    requestText: r.request_text ?? null,
    summary: r.summary ?? null,
    suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
    suggestionCount: Number(r.suggestion_count ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    cached: !!r.cached,
    error: r.error ?? null,
  };
}
