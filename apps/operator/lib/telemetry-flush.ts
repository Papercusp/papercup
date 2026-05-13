/**
 * Telemetry flush worker — PostHog edition.
 *
 * Moves reports out of the in-app ring buffer (operator-state-pg key
 * 'telemetry_reports') into the long-term local archive
 * (harness_shared.telemetry_reports_archive), and — when ALL of the
 * following are true — emits one PostHog event per archive row that
 * hasn't been forwarded yet:
 *
 *   1. PostHog discovery file or env vars are configured AND
 *      testingFeatures === true (shared posthog-config.ts resolver).
 *      This is the privacy moat — shipped binaries are unconfigured by
 *      default so they make ZERO outbound PostHog calls regardless of
 *      what the user does in the Setup Wizard.
 *   2. setup_wizard_state.telemetry_enabled === true (user opted in
 *      via the wizard's Step 12).
 *
 * Both must be true. The wizard's opt-in is a no-op unless an admin
 * has bootstrapped the discovery file with testingFeatures: true.
 *
 * When either gate fails this worker still archives locally so the
 * user can see their own reports — it just doesn't forward.
 */
import { getOrgPg } from '@restart/db-org';
import { PostHog } from 'posthog-node';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';
import { ensureInstallId } from './setup-wizard-install-id';
import { getPosthogConfigWithSource } from './posthog-config';

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
  testingFeatures: boolean;
  optedIn: boolean;
}

const RETENTION_DAYS = Number(process.env.PAPERCUSP_TELEMETRY_RETENTION_DAYS ?? 30);

async function resolveTelemetryConfig(): Promise<{
  host?: string;
  projectKey?: string;
  distinctId: string;
  optedIn: boolean;
  testingFeatures: boolean;
}> {
  const state = await readOperatorState<{ telemetry_enabled?: boolean }>('setup_wizard_state');
  const optedIn = Boolean(state?.telemetry_enabled);
  // Use the shared resolver — never read PAPERCUSP_POSTHOG_* env vars
  // directly. testingFeatures is the master privacy switch; if it's
  // false we don't even pull the host/key, so an opt-in user on an
  // unconfigured machine still phones home to nothing.
  const phResolved = getPosthogConfigWithSource();
  const distinctId = await ensureInstallId();
  if (!phResolved.testingFeatures || !phResolved.config) {
    return { distinctId, optedIn, testingFeatures: phResolved.testingFeatures };
  }
  return {
    host: phResolved.config.host,
    projectKey: phResolved.config.projectKey,
    distinctId,
    optedIn,
    testingFeatures: true,
  };
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
    testingFeatures: false,
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

  // 2. Forward to PostHog. Requires BOTH:
  //      a) testingFeatures === true (admin opted the machine in)
  //      b) telemetry_enabled === true (user opted in via wizard Step 12)
  const config = await resolveTelemetryConfig();
  result.optedIn = config.optedIn;
  result.testingFeatures = config.testingFeatures;
  if (config.optedIn && config.testingFeatures && config.host && config.projectKey) {
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
            distinctId: config.distinctId,
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
