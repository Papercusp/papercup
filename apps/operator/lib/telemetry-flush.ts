/**
 * Telemetry flush worker — PostHog edition.
 *
 * Moves reports out of the in-app ring buffer (operator-state-pg key
 * 'telemetry_reports') into the long-term local archive
 * (harness_shared.telemetry_reports_archive), and — when PostHog is
 * configured AND telemetry is opted-in — emits one PostHog event per
 * archive row that hasn't been forwarded yet.
 *
 * Telemetry is OFF by default. The user opts in via the Setup Wizard
 * (Step 12). When opt-in is false (or unset) this worker still
 * archives locally so the user can see their own reports, but it
 * forwards nothing.
 *
 * PostHog config priority:
 *   1. setup_wizard_state.telemetry_host + .telemetry_project_key (PG)
 *   2. PAPERCUSP_POSTHOG_HOST + PAPERCUSP_POSTHOG_KEY (env)
 *
 * If neither is set, archived rows are kept locally and retried on
 * future flushes once config lands.
 */
import { getOrgPg } from '@restart/db-org';
import { PostHog } from 'posthog-node';
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
  posthogConfigured: boolean;
  optedIn: boolean;
}

const RETENTION_DAYS = Number(process.env.PAPERCUSP_TELEMETRY_RETENTION_DAYS ?? 30);

async function resolvePostHogConfig(): Promise<{ host?: string; projectKey?: string; optedIn: boolean }> {
  const state = await readOperatorState<{
    telemetry_enabled?: boolean;
    telemetry_host?: string;
    telemetry_project_key?: string;
  }>('setup_wizard_state');
  const optedIn = Boolean(state?.telemetry_enabled);
  const host = state?.telemetry_host || process.env.PAPERCUSP_POSTHOG_HOST;
  const projectKey = state?.telemetry_project_key || process.env.PAPERCUSP_POSTHOG_KEY;
  return { host, projectKey, optedIn };
}

export async function flushTelemetry(): Promise<FlushResult> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const result: FlushResult = {
    archived: 0,
    forwarded: 0,
    forwardFailed: 0,
    retentionDeleted: 0,
    posthogConfigured: false,
    optedIn: false,
  };

  // 1. Drain ring buffer into local archive (regardless of opt-in —
  //    local visibility is fine without consent; we only stop short of
  //    *forwarding* off-device).
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

  // 2. Forward to PostHog, but ONLY if the user opted in.
  const config = await resolvePostHogConfig();
  result.optedIn = config.optedIn;
  if (config.optedIn && config.host && config.projectKey) {
    result.posthogConfigured = true;
    const ph = new PostHog(config.projectKey, {
      host: config.host,
      flushAt: 1, // smaller batches; flush each capture immediately
      flushInterval: 0,
    });
    try {
      const pending = await sql<
        Array<{
          id: string;
          received_at: Date;
          kind: string;
          app_version: string | null;
          os: string | null;
          payload: unknown;
        }>
      >`
        SELECT id, received_at, kind, app_version, os, payload
          FROM harness_shared.telemetry_reports_archive
         WHERE forwarded_at IS NULL AND workspace_id = ${workspaceId}
         ORDER BY received_at ASC
         LIMIT 100
      `;
      for (const row of pending) {
        try {
          ph.capture({
            distinctId: workspaceId,
            event: `papercusp_${row.kind}`,
            timestamp: row.received_at,
            properties: {
              app_version: row.app_version,
              os: row.os,
              payload: row.payload,
              $set: { app_version: row.app_version, os: row.os },
              source: 'desktop',
            },
          });
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
      await ph.shutdown();
    } catch (e) {
      console.error('[telemetry-flush] posthog batch failed:', (e as Error)?.message ?? e);
    }
  }

  // 3. Enforce retention on the local archive.
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
 *
 * Note: the timer ALWAYS runs (so retention still kicks in and local
 * archive stays bounded). What it forwards off-device is gated by
 * setup_wizard_state.telemetry_enabled.
 */
export function startTelemetryFlushWorker(): void {
  if (timer) return;
  const intervalMs = Number(process.env.PAPERCUSP_TELEMETRY_FLUSH_MS ?? 60 * 60 * 1000);
  timer = setInterval(() => {
    flushTelemetry().catch((e) => {
      console.error('[telemetry-flush] failed:', e);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}
