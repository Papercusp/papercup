/**
 * POST /api/desktop/report-problem against a fully migrated Postgres
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048; R-1 slice per D-045):
 *  - the door files the previewed payload through the ONE shared intake, so a
 *    desktop report and an agent's report of the same error land as one bug that
 *    carries both reporter kinds and the captured screen context;
 *  - a ticked log excerpt lands in the consented-attachment store (door 'desktop');
 *  - a payload changed after the preview is refused and files nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('../../../harness/improvements/capture-core');
const { createIssue } = await import('../../../issues-engineer');
const { intakeEndUserReport } = await import('../../../harness/improvements/end-user-intake');
const { putReportAttachment } = await import('../../../harness/improvements/report-attachments');
const { buildProblemReport, previewDigest } = await import('../../../harness/improvements/problem-report');
const { handleReportProblem } = await import('./report-problem');
const { contributeUpstream } = await import('../../../pot/contribute-upstream');
const { buildEngineerIssuesProjection } = await import('../../../sync/hyperbee/projections/engineer-issues');
type EngineerIssueRow = import('../../../sync/hyperbee/projections/engineer-issues').EngineerIssueRow;
type ReportProblemDeps = import('./report-problem').ReportProblemDeps;

const WORKSPACE = 'papercusp-workspace';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// No similarity search: this pins the error-signature fold, which needs no search.
const capture = (input: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(input, { searchIssues: async () => [], createIssue });

const notes: string[] = [];
const deps: ReportProblemDeps = {
  intake: (input) => intakeEndUserReport(input, { capture, rememberNote: async (content) => (notes.push(content), ['mem-1']) }),
  putAttachment: (input) => putReportAttachment(input),
  workspaceId: () => WORKSPACE,
};

function suffix(): string {
  return `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
}

async function rowsMentioning(marker: string) {
  return db.adminSql<{ feature_id: string; title: string; payload: Record<string, unknown> }[]>`
    SELECT feature_id, title, payload FROM harness_shared.work_items
     WHERE title ILIKE ${`%${marker}%`} OR payload::text ILIKE ${`%${marker}%`}`;
}

describe('desktop Report a problem door, end to end', () => {
  it('P-015: contribution captures once and the existing issue CDC projects report context upstream', async () => {
    const s = suffix();
    const upstreamWorkspace = `p015-upstream-${s}`;
    const intake = vi.fn(deps.intake);
    const localFallback = vi.fn(deps.intake);
    const payload = buildProblemReport({ text: `Export crashes p015-${s}`, appVersion: '0.9.4',
      route: '/harness/papercusp/board', search: '?view=kanban',
      recentErrors: [{ source: 'window.error', message: `TypeError: p015${s} is undefined` }] });
    const out = await handleReportProblem({ payload, previewDigest: await previewDigest(payload) }, {
      ...deps, intake: localFallback,
      contribute: (input) => contributeUpstream({ kind: 'report', confirm: true, workspaceId: WORKSPACE,
        report: { text: input.text, reportContext: input.reportContext },
        hasCanonicalReportMembership: async () => true, intakeReport: intake }),
    });
    expect(out.status).toBe(200);
    if (out.status !== 200) throw new Error(JSON.stringify(out));
    expect(out.body.delivery).toBe('queued-for-federation');
    expect(intake).toHaveBeenCalledOnce();
    expect(localFallback).not.toHaveBeenCalled();
    const id = out.body.id!;
    // Real capture trigger / outbox row, not a hand-authored substitute payload.
    const [op] = await db.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
      SELECT row, ts FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WORKSPACE} AND table_name = 'engineer_issues'
         AND row->>'issue_id' = ${id} ORDER BY id DESC LIMIT 1`;
    expect(op, 'installed report must enter the existing issue federation outbox').toBeDefined();
    const projection = buildEngineerIssuesProjection({ workspaceId: upstreamWorkspace, harnessSlug: 'papercusp', sql: db.adminSql });
    await projection.writeToPg(op!.row, { ts: Number(op!.ts), origin: 'remote', authorPubkey: 'p015-admitted-install' });
    const [upstream] = await db.adminSql<{ origin: string; payload: Record<string, unknown> }[]>`
      SELECT origin, payload FROM harness_shared.work_items
       WHERE workspace_id = ${upstreamWorkspace} AND feature_id = ${id}`;
    expect(upstream?.origin).toBe('remote');
    expect(upstream?.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('0.9.4');
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('kanban');
    // Scope: real PG CDC -> real PG projection. No live swarm delivery claim.
  });

  it("folds the desktop report and an agent's report of the same error into one bug", async () => {
    const s = suffix();
    const payload = buildProblemReport({
      text: `Export to CSV does nothing on board ${s}`,
      appVersion: '0.9.3 (abc1234)',
      route: '/harness/papercusp/board',
      search: '?view=kanban&report=true',
      recentErrors: [{ source: 'window.error', message: `TypeError: Cannot read properties of undefined (reading 'csvRows${s}') at 41:17` }],
      attachLog: true,
      logLines: ['2026-10-06T22:00:00Z error export failed', '2026-10-06T22:00:01Z warn retrying'],
    });

    const out = await handleReportProblem({ payload, previewDigest: await previewDigest(payload) }, deps);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.routed).toBe('work-item');
    const id = out.body.id;
    expect(id).toMatch(/^(EI|WI)-/);
    expect(out.body.attachments).toEqual([expect.objectContaining({ kind: 'log', ok: true })]);

    // An agent reports the same error, different position and wrapper.
    const agent = await capture({
      title: `CSV export throws on board (${s})`,
      kind: 'bug',
      scope: 'harness:papercusp',
      workspaceId: WORKSPACE,
      createdBy: 'su-integration-agent',
      reportContext: {
        recentErrors: [{ message: `Uncaught TypeError: Cannot read properties of undefined (reading 'csvRows${s}') at 88:3`, source: 'renderer' }],
      },
    });
    // On a miss, say WHY the two reports did not fold: their tenancy and signature side by side.
    const keys = await db.adminSql`
      SELECT feature_id, workspace_id, harness_slug, payload->>'scope' AS scope,
             payload->>'errorSignature' AS signature, payload->'reporter'->>'kind' AS reporter
        FROM harness_shared.work_items
       WHERE title ILIKE ${`%${s}%`} OR payload::text ILIKE ${`%csvRows${s}%`} ORDER BY feature_id`;
    expect(agent.created, `agent report did not fold onto the desktop report: ${JSON.stringify(keys)}`).toBe(false);
    expect(agent.issue?.id ?? agent.coalescedOnto?.id).toBe(id);

    const rows = await rowsMentioning(`csvRows${s}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.feature_id).toBe(id);
    expect(row.title).toContain('Export to CSV does nothing');
    expect(row.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(row.payload.reporterKinds).toEqual(expect.arrayContaining(['agent', 'end-user']));
    // The captured screen context rides on the row: the route and the user-meaningful params, not the dialog's own.
    const context = JSON.stringify(row.payload.reportContext ?? row.payload);
    expect(context).toContain('/harness/papercusp/board');
    expect(context).toContain('kanban');
    expect(context).toContain('0.9.3 (abc1234)');
    // Anonymous: nothing identifies the desktop reporter.
    expect(JSON.stringify(row.payload.reporter)).not.toMatch(/user-|@/);

    const atts = await db.adminSql<{ door: string; kind: string; redaction: string }[]>`
      SELECT door, kind, redaction FROM harness_shared.report_attachments WHERE work_item_id = ${id!}`;
    expect(atts).toEqual([{ door: 'desktop', kind: 'log', redaction: 'redacted' }]);
  });

  it('files nothing when the payload was changed after the preview', async () => {
    const s = suffix();
    const shown = buildProblemReport({ text: `Settings page freezes ${s}`, route: '/settings' });
    const digest = await previewDigest(shown);
    const sent = { ...shown, text: `${shown.text} and also something the preview never showed` };

    const out = await handleReportProblem({ payload: sent, previewDigest: digest }, deps);
    expect(out).toMatchObject({ status: 409, body: { error: 'preview-mismatch' } });
    expect(await rowsMentioning(`freezes ${s}`)).toHaveLength(0);
  });
});
