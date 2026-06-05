/**
 * GET  /api/desktop/telemetry-report — read the stored report ring.
 * POST /api/desktop/telemetry-report — accept an anonymized crash /
 *   diagnostic report (rejected with 403 when telemetry is disabled).
 *
 * Ported from app/api/desktop/telemetry-report/route.ts. `auth: {}`.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { recordTelemetryReport, type StoredTelemetryReport } from '../../../record-telemetry';
import { defineTool } from '@papercusp/agent-mcp';

const REPORTS_KEY = 'telemetry_reports';
const WIZARD_KEY = 'setup_wizard_state';

interface ReportsState {
  reports: StoredTelemetryReport[];
}

function defaults(): ReportsState {
  return { reports: [] };
}

const get = defineTool({
  method: 'GET',
  path: '/desktop/telemetry-report',
  auth: {},
  async handler() {
    const state = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
    return Response.json(state);
  },
});

const post = defineTool({
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
      const { isTelemetryKind } = await import('../../../telemetry-kinds');
      knownKind = isTelemetryKind(kind);
    } catch { /* taxonomy module unavailable — fail-open */ }

    // Enqueue via the shared server-side helper (single ring-buffer impl,
    // reused by operator-internal emitters like the substrate admission path).
    const stored = await recordTelemetryReport({
      kind,
      app_version: typeof body.app_version === 'string' ? body.app_version : undefined,
      os: typeof body.os === 'string' ? body.os : undefined,
      payload: knownKind
        ? (body.payload ?? null)
        : { _wireDrift: true, kind, original: body.payload ?? null },
    });
    return Response.json({ ok: true, stored });
  },
});

export default [get, post];
