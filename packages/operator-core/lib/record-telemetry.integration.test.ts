/** Redacted browser crash reports must survive the real operator-state PG
 * write path before the hourly archive flush. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { readOperatorState } = await import('./operator-state-pg');
const { recordTelemetryReport } = await import('./record-telemetry');
const { normalizeRenderCrashPayload } = await import('./endpoint-route/routes/desktop/telemetry-report');

const WS = 'ws-redacted-render-crash-persistence';

describe('redacted render crash persistence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
  }, 120_000);

  afterAll(async () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    await db?.cleanup();
  });

  it('stores the server-normalized report in the existing workspace-scoped ring', async () => {
    const payload = normalizeRenderCrashPayload({
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning', message: 'secret-token=abc',
      stack: 'private stack', url: 'https://example.invalid/?secret-token=abc',
    });
    expect(payload).toMatchObject({ fingerprint: 'adv-tab:TypeError:LearningTab:learning' });
    await recordTelemetryReport({
      kind: 'crash', payload,
      receivedAt: '2026-09-25T18:00:00Z',
    });
    const ring = await readOperatorState<{ reports: Array<{ kind: string; payload: unknown }> }>('telemetry_reports');
    expect(ring?.reports).toHaveLength(1);
    expect(ring?.reports[0]).toMatchObject({ kind: 'crash', payload });
    const rows = await db.adminSql<Array<{ payload: { reports: unknown[] } }>>`
      SELECT payload FROM harness_shared.telemetry_reports WHERE workspace_id = ${WS}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.reports).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('secret-token');
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('https://');
  });
});
