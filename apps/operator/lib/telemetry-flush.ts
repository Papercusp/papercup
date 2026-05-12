/**
 * Telemetry flush worker.
 *
 * Moves reports out of the in-app ring buffer (operator-state-pg key
 * 'telemetry_reports') into the long-term archive
 * (harness_shared.telemetry_reports_archive), and — when a remote sink
 * URL is configured — POSTs not-yet-forwarded archive rows to it.
 *
 * Design:
 *   - Idempotent. Safe to call repeatedly; nothing gets archived twice.
 *   - One archive insert per report. Retention is purely a function of
 *     `received_at`; the cleanup step deletes rows older than
 *     PAPERCUSP_TELEMETRY_RETENTION_DAYS (default 30).
 *   - Forwarding is separate from archiving so a failed sink doesn't
 *     block archiving. `forwarded_at` is set on success; NULLs get
 *     retried next flush.
 *
 * Configuration:
 *   - Sink URL: setup_wizard_state.telemetry_sink_url
 *               (or PAPERCUSP_TELEMETRY_SINK_URL env override)
 *   - Sink token: PAPERCUSP_TELEMETRY_SINK_TOKEN (sent as Authorization)
 *   - Retention: PAPERCUSP_TELEMETRY_RETENTION_DAYS (default 30)
 *
 * Callers:
 *   - Hourly setInterval from instrumentation-node.ts on boot.
 *   - POST /api/desktop/telemetry-flush for manual / test triggers.
 */
import { getOrgPg } from '@restart/db-org';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';

interface BufferedReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: BufferedReport[];
}

export interface FlushResult {
  archived: number;
  forwarded: number;
  forwardFailed: number;
  retentionDeleted: number;
  sinkConfigured: boolean;
}

const RETENTION_DAYS = Number(process.env.PAPERCUSP_TELEMETRY_RETENTION_DAYS ?? 30);

async function resolveSinkConfig(): Promise<{ url?: string; token?: string }> {
  const fromEnv = process.env.PAPERCUSP_TELEMETRY_SINK_URL;
  if (fromEnv) return { url: fromEnv, token: process.env.PAPERCUSP_TELEMETRY_SINK_TOKEN };
  const state = await readOperatorState<{ telemetry_sink_url?: string }>('setup_wizard_state');
  return { url: state?.telemetry_sink_url, token: process.env.PAPERCUSP_TELEMETRY_SINK_TOKEN };
}

export async function flushTelemetry(): Promise<FlushResult> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const result: FlushResult = {
    archived: 0,
    forwarded: 0,
    forwardFailed: 0,
    retentionDeleted: 0,
    sinkConfigured: false,
  };

  // 1. Drain ring buffer into archive.
  const buffer = await readOperatorState<ReportsState>('telemetry_reports');
  const reports = buffer?.reports ?? [];
  for (const r of reports) {
    await sql`
      INSERT INTO harness_shared.telemetry_reports_archive
        (workspace_id, received_at, kind, app_version, os, payload)
      VALUES (
        ${workspaceId},
        ${r.received_at}::timestamptz,
        ${r.kind},
        ${r.app_version ?? null},
        ${r.os ?? null},
        ${r.payload ? JSON.stringify(r.payload) : null}::jsonb
      )
    `;
    result.archived++;
  }
  if (reports.length > 0) {
    await writeOperatorState('telemetry_reports', { reports: [] });
  }

  // 2. Forward archive rows that haven't been forwarded yet.
  const sink = await resolveSinkConfig();
  if (sink.url) {
    result.sinkConfigured = true;
    const pending = await sql<
      Array<{ id: string; received_at: Date; kind: string; app_version: string | null; os: string | null; payload: unknown }>
    >`
      SELECT id, received_at, kind, app_version, os, payload
        FROM harness_shared.telemetry_reports_archive
       WHERE forwarded_at IS NULL AND workspace_id = ${workspaceId}
       ORDER BY received_at ASC
       LIMIT 100
    `;
    for (const row of pending) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (sink.token) headers.Authorization = `Bearer ${sink.token}`;
        const res = await fetch(sink.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspace_id: workspaceId,
            received_at: row.received_at,
            kind: row.kind,
            app_version: row.app_version,
            os: row.os,
            payload: row.payload,
          }),
        });
        if (!res.ok) {
          result.forwardFailed++;
          continue;
        }
        await sql`
          UPDATE harness_shared.telemetry_reports_archive
             SET forwarded_at = now()
           WHERE id = ${row.id}
        `;
        result.forwarded++;
      } catch {
        result.forwardFailed++;
      }
    }
  }

  // 3. Enforce retention.
  if (Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0) {
    const deleted = await sql<{ count: number }[]>`
      WITH d AS (
        DELETE FROM harness_shared.telemetry_reports_archive
         WHERE received_at < now() - (${RETENTION_DAYS} || ' days')::interval
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM d
    `;
    result.retentionDeleted = deleted[0]?.count ?? 0;
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the hourly flush timer. Idempotent — calling again is a no-op.
 * Wired from instrumentation-node.ts so it boots with the operator.
 */
export function startTelemetryFlushWorker(): void {
  if (timer) return;
  const intervalMs = Number(process.env.PAPERCUSP_TELEMETRY_FLUSH_MS ?? 60 * 60 * 1000);
  timer = setInterval(() => {
    flushTelemetry().catch((e) => {
      console.error('[telemetry-flush] failed:', e);
    });
  }, intervalMs);
  // Don't keep the process alive solely for the timer.
  if (typeof timer.unref === 'function') timer.unref();
}
