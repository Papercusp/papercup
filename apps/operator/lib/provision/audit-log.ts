/**
 * Provision audit log — PG-backed (migration 026).
 *
 * Append-only log of every provision event for `(workspace, harness, plugin)`.
 * Each audit entry is one row in `harness_shared.provision_audit_log`,
 * indexed for the common "all events for (harness, plugin) ordered by
 * ts" query.
 *
 * Was previously per-(harness, plugin) audit.log files with a 10MB
 * size cap and oldest-25%-truncation logic. PG can absorb the volume
 * without truncation; if a future retention policy is needed it lives
 * as a scheduled DELETE rather than in-band file rewriting.
 *
 * Spec: /docs/snapshots/build-scripts#audit-log.
 */

import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { publish as publishAudit } from '@/lib/provision-audit-bus';

export type AuditKind =
  | 'consent-granted'
  | 'consent-rejected'
  | 'setup-started'
  | 'setup-succeeded'
  | 'setup-failed'
  | 'teardown-started'
  | 'teardown-succeeded'
  | 'teardown-failed'
  | 'verify-started'
  | 'verify-succeeded'
  | 'verify-failed'
  | 'resource-recorded'
  | 'script-output'
  | 'log-truncated'
  | 'sandbox-bypass'
  | 'state-set';

export interface AuditEntry {
  ts: string;
  kind: AuditKind;
  /** Optional run-id linking related entries. */
  runId?: string;
  /** Per-event payload — kept small. */
  data?: Record<string, unknown>;
}

/**
 * Append a single audit entry. Drops the prior `capMb` argument — PG
 * doesn't need the truncation logic. Existing callers that pass it are
 * silently ignored (no break).
 */
export async function appendAudit(
  harness: string,
  plugin: string,
  entry: Omit<AuditEntry, 'ts'> & { ts?: string },
  _capMb?: number, // ignored — kept for source compatibility
): Promise<void> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const ts = entry.ts ?? new Date().toISOString();
  await sql`
    INSERT INTO harness_shared.provision_audit_log (workspace_id, harness_slug, plugin_slug, ts, kind, run_id, data)
    VALUES (${ws}, ${harness}, ${plugin}, ${ts}::timestamptz, ${entry.kind}, ${entry.runId ?? null}, ${entry.data ? sql.json(entry.data as Record<string, never>) : null})
  `;
  // Fan out to in-process subscribers (provision/stream SSE) so the UI
  // updates sub-millisecond after the row commits — no file polling.
  publishAudit(`${harness}:${plugin}`, { ts, ...entry });
}

export async function readAudit(
  harness: string,
  plugin: string,
  opts: { limit?: number; sinceTs?: string } = {},
): Promise<AuditEntry[]> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const limit = opts.limit ?? 1_000;
  const since = opts.sinceTs ?? null;

  const rows = await sql<
    { ts: Date; kind: AuditKind; run_id: string | null; data: Record<string, unknown> | null }[]
  >`
    SELECT ts, kind, run_id, data
    FROM harness_shared.provision_audit_log
    WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND plugin_slug = ${plugin}
      ${since ? sql`AND ts > ${since}::timestamptz` : sql``}
    ORDER BY ts ASC, id ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    ts: r.ts.toISOString(),
    kind: r.kind,
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.data ? { data: r.data } : {}),
  }));
}

/**
 * High-throughput stream-append for in-process script-output capture.
 * Each `write()` is a separate `script-output` audit row. Inserts happen
 * one per call; PG's prepared-statement cache + connection-pooled
 * postgres-js client makes this fast enough for typical script verbosity.
 * Caller is still responsible for `open()` (no-op) + `close()` (no-op)
 * for source-compat with the prior streaming implementation.
 */
export class AuditStream {
  constructor(
    private harness: string,
    private plugin: string,
    private runId: string,
  ) {}
  async open(): Promise<void> {
    /* no-op: PG client is shared and managed elsewhere */
  }
  async write(line: string): Promise<void> {
    await appendAudit(this.harness, this.plugin, {
      kind: 'script-output',
      runId: this.runId,
      data: { line: line.replace(/\n$/, '') },
    });
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
