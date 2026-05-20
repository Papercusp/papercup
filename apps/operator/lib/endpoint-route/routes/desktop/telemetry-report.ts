/**
 * GET  /api/desktop/telemetry-report — read the stored report ring.
 * POST /api/desktop/telemetry-report — accept an anonymized crash /
 *   diagnostic report (rejected with 403 when telemetry is disabled).
 *
 * Ported from app/api/desktop/telemetry-report/route.ts. `auth: {}`.
 */
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';
import { defineRoute } from '../../define-route';

const REPORTS_KEY = 'telemetry_reports';
const WIZARD_KEY = 'setup_wizard_state';
const MAX_REPORTS = 100;

interface StoredReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: StoredReport[];
}

function defaults(): ReportsState {
  return { reports: [] };
}

const get = defineRoute({
  method: 'GET',
  path: '/desktop/telemetry-report',
  auth: {},
  async handler() {
    const state = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
    return Response.json(state);
  },
});

const post = defineRoute({
  method: 'POST',
  path: '/desktop/telemetry-report',
  auth: {},
  async handler(req) {
    const wizard = await readOperatorState<{ telemetry_enabled?: boolean }>(WIZARD_KEY);
    if (!wizard?.telemetry_enabled) {
      return Response.json({ error: 'telemetry disabled' }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    const kind = typeof body.kind === 'string' ? body.kind : 'unknown';
    if (kind.length > 64) return Response.json({ error: 'kind too long' }, { status: 400 });
    // Soft-validate against the known taxonomy. Unknown kinds are stored
    // but flagged so analysis can spot wire drift.
    let knownKind = false;
    try {
      const { isTelemetryKind } = await import('@/lib/telemetry-kinds');
      knownKind = isTelemetryKind(kind);
    } catch { /* taxonomy module unavailable — fail-open */ }

    const report: StoredReport = {
      received_at: new Date().toISOString(),
      kind,
      app_version: typeof body.app_version === 'string' ? body.app_version : undefined,
      os: typeof body.os === 'string' ? body.os : undefined,
      payload: knownKind
        ? (body.payload ?? null)
        : { _wireDrift: true, kind, original: body.payload ?? null },
    };

    const current = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
    const next: ReportsState = {
      reports: [report, ...current.reports].slice(0, MAX_REPORTS),
    };
    await writeOperatorState(REPORTS_KEY, next);
    return Response.json({ ok: true, stored: report });
  },
});

export default [get, post];
