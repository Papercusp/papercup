/**
 * D1 storage for the public transparency report (P-044, D-028; migration
 * 042_transparency.sql). The live row only moves forward in time; a monthly
 * statement is immutable once stored.
 */
import type { SignedStatement } from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';

export interface LiveReportRow {
  readonly month: string;
  readonly report: unknown;
  readonly generatedAtMs: number;
}

export async function recordLiveReport(
  db: D1Database,
  input: { workspaceId: string; month: string; reportJson: string; generatedAtMs: number; receivedAtMs: number },
): Promise<'stored' | 'stale'> {
  const r = await db
    .prepare(
      `INSERT INTO transparency_live (workspace_id, month, report_json, generated_at_ms, received_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (workspace_id) DO UPDATE SET
         month = excluded.month, report_json = excluded.report_json,
         generated_at_ms = excluded.generated_at_ms, received_at_ms = excluded.received_at_ms
       WHERE excluded.generated_at_ms >= transparency_live.generated_at_ms`,
    )
    .bind(input.workspaceId, input.month, input.reportJson, input.generatedAtMs, input.receivedAtMs)
    .run();
  return (r.meta?.changes ?? 0) > 0 ? 'stored' : 'stale';
}

export async function readLiveReport(db: D1Database, workspaceId: string): Promise<LiveReportRow | null> {
  const row = await db
    .prepare(`SELECT month, report_json, generated_at_ms FROM transparency_live WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<{ month: string; report_json: string; generated_at_ms: number }>();
  return row ? { month: row.month, report: JSON.parse(row.report_json), generatedAtMs: Number(row.generated_at_ms) } : null;
}

export type StatementWrite = 'created' | 'unchanged' | { readonly conflict: string };

/** First publication wins: an identical digest is a no-op, a different one is refused. */
export async function publishStatement(db: D1Database, signed: SignedStatement, nowMs: number): Promise<StatementWrite> {
  const { workspaceId, month } = signed.statement.report;
  const inserted = await db
    .prepare(
      `INSERT INTO transparency_statements (workspace_id, month, digest, signature, signer, signed_json, published_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (workspace_id, month) DO NOTHING`,
    )
    .bind(workspaceId, month, signed.digest, signed.signature, signed.signer, JSON.stringify(signed), nowMs)
    .run();
  if ((inserted.meta?.changes ?? 0) > 0) return 'created';
  const existing = await db
    .prepare(`SELECT digest FROM transparency_statements WHERE workspace_id = ?1 AND month = ?2`)
    .bind(workspaceId, month)
    .first<{ digest: string }>();
  return existing?.digest === signed.digest ? 'unchanged' : { conflict: existing?.digest ?? 'unknown' };
}

export async function readStatement(db: D1Database, workspaceId: string, month: string): Promise<SignedStatement | null> {
  const row = await db
    .prepare(`SELECT signed_json FROM transparency_statements WHERE workspace_id = ?1 AND month = ?2`)
    .bind(workspaceId, month)
    .first<{ signed_json: string }>();
  return row ? (JSON.parse(row.signed_json) as SignedStatement) : null;
}

export async function listStatements(
  db: D1Database,
  workspaceId: string,
): Promise<{ month: string; digest: string; signer: string; publishedAtMs: number }[]> {
  const rows = await db
    .prepare(
      `SELECT month, digest, signer, published_at_ms FROM transparency_statements
        WHERE workspace_id = ?1 ORDER BY month DESC LIMIT 120`,
    )
    .bind(workspaceId)
    .all<{ month: string; digest: string; signer: string; published_at_ms: number }>();
  return (rows.results ?? []).map((r) => ({ month: r.month, digest: r.digest, signer: r.signer, publishedAtMs: Number(r.published_at_ms) }));
}
