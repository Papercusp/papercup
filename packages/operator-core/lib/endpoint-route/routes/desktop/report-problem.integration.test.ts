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
const { createIssue, claimIssue } = await import('../../../issues-engineer');
const { recordIssueOccurrence } = await import('../../../issue-occurrence-ledger');
const { intakeEndUserReport } = await import('../../../harness/improvements/end-user-intake');
const { putReportAttachment } = await import('../../../harness/improvements/report-attachments');
const { buildProblemReport, previewDigest } = await import('../../../harness/improvements/problem-report');
const { handleReportProblem, answerReportFollowUp } = await import('./report-problem');
const { askReporterQuestion, readReporterStatus } = await import('../../../harness/improvements/reporter-status');
const { runWithWorkspace } = await import('../../../workspace-als');
const { contributeUpstream } = await import('../../../pot/contribute-upstream');
const { buildEngineerIssuesProjection } = await import('../../../sync/hyperbee/projections/engineer-issues');
const { errorSignatureOf } = await import('../../../harness/improvements/error-signature');
const { currentIntakeSourceRevision, executeIntakeDecision } = await import('../../../attention/intake-promotion');
const { parseIntakeDecision } = await import('../../../attention/bulk-dispositions');
const { publishReporterRelease, defaultReporterReleaseDeps } = await import('../../../../../../apps/operator/lib/release/reporter-release');
type EngineerIssueRow = import('../../../sync/hyperbee/projections/engineer-issues').EngineerIssueRow;
type ReportProblemDeps = import('./report-problem').ReportProblemDeps;

const WORKSPACE = 'papercusp-workspace';
let db: OrgTestDb;
let upstreamDb: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  upstreamDb = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  await upstreamDb?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// No similarity search: this pins the error-signature fold, which needs no search.
const capture = (input: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(input, { searchIssues: async () => [], createIssue,
    // The occurrence writer's unit-test safeguard requires an explicit SQL
    // binding. Use the active peer's real database, just like the intake.
    recordIssueOccurrence: (occurrence) => recordIssueOccurrence(occurrence, h.sql),
  });

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
    // A peer is a separate database, not a second workspace in the SAME DB:
    // work_items' physical primary key is (harness_slug, feature_id).
    const upstreamWorkspace = WORKSPACE;
    const [sourceDatabase] = await db.adminSql<{ name: string }[]>`SELECT current_database() AS name`;
    const [targetDatabase] = await upstreamDb.adminSql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(targetDatabase!.name).not.toBe(sourceDatabase!.name);
    const intake = vi.fn(deps.intake);
    const localFallback = vi.fn(deps.intake);
    const errorMessage = `TypeError: CSV export rows are missing for p015${s}`;
    const agentMessage = `Uncaught ${errorMessage}`;
    // Preflight the instrument: short/generic errors intentionally do not get
    // a dedup key. Never let random suffix length decide fixture eligibility.
    const signature = errorSignatureOf({ source: 'window.error', message: errorMessage });
    expect(signature).not.toBeNull();
    expect(errorSignatureOf({ source: 'renderer', message: agentMessage })?.key).toBe(signature?.key);
    const payload = buildProblemReport({ text: `Export crashes p015-${s}`, appVersion: '0.9.4',
      route: '/harness/papercusp/board', search: '?view=kanban',
      recentErrors: [{ source: 'window.error', message: errorMessage }] });
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
    expect(op!.row.harness_slug, JSON.stringify({ harness: op!.row.harness_slug, scope: op!.row.scope, storage: op!.row.storage_harness_slug })).toBe('papercusp');
    const projection = buildEngineerIssuesProjection({ workspaceId: upstreamWorkspace, harnessSlug: 'papercusp', sql: upstreamDb.adminSql });
    await projection.writeToPg(op!.row, { ts: Number(op!.ts), origin: 'remote', authorPubkey: 'p015-admitted-install' });
    const [upstream] = await upstreamDb.adminSql<{ origin: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
      SELECT origin, title, summary, payload FROM harness_shared.work_items
       WHERE workspace_id = ${upstreamWorkspace} AND feature_id = ${id}`;
    expect(upstream?.origin).toBe('remote');
    expect(upstream?.payload.reporter).toMatchObject({ kind: 'end-user' });
    expect(upstream?.payload.watchdogKey).toBe(signature!.key);
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('0.9.4');
    expect(JSON.stringify(upstream?.payload.reportContext)).toContain('kanban');
    const [source] = await db.adminSql<{ origin: string }[]>`
      SELECT origin FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE} AND feature_id = ${id}`;
    expect(source?.origin).toBe('local');
    // The upstream agent uses the SAME capture intake; no second report type.
    h.sql = upstreamDb.adminSql;
    try {
      const agent = await capture({ title: `Agent export failure p015-${s}`, kind: 'bug',
        scope: 'harness:papercusp', workspaceId: upstreamWorkspace, createdBy: 'su-upstream-reviewer',
        reportContext: { recentErrors: [{ source: 'renderer', message: agentMessage }] } });
      const keys = await upstreamDb.adminSql`
        SELECT feature_id, workspace_id, harness_slug, payload->>'watchdogKey' AS watchdog_key,
               payload->'errorSignature' AS signature, payload->'_ei'->>'signal_origin' AS signal_origin
          FROM harness_shared.work_items WHERE feature_id = ${id} OR payload->>'watchdogKey' = ${signature!.key}`;
      expect(agent.created, `source/agent signature preflight passed; upstream identities: ${JSON.stringify(keys)}`).toBe(false);
      expect(agent.issue?.id ?? agent.coalescedOnto?.id).toBe(id);
      const [folded] = await upstreamDb.adminSql<{ origin: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
        SELECT origin, title, summary, payload FROM harness_shared.work_items WHERE workspace_id = ${upstreamWorkspace} AND feature_id = ${id}`;
      expect(folded?.origin, 'corroboration must not transfer foreign authorship to this peer').toBe('remote');
      expect(folded?.title, 'corroboration preserves the reporting peer’s original title').toBe(upstream?.title);
      expect(folded?.summary, 'corroboration preserves the reporting peer’s original evidence').toBe(upstream?.summary);
      expect(folded?.payload.reporterKinds).toEqual(upstream?.payload.reporterKinds);
      const occurrences = await upstreamDb.adminSql<{ reporter: string }[]>`
        SELECT reporter FROM harness_shared.work_item_occurrences
         WHERE workspace_id = ${upstreamWorkspace} AND canonical_work_item_id = ${id}`;
      expect(occurrences.map((row) => row.reporter)).toContain('su-upstream-reviewer');

      // A foreign row is evidence, not something this upstream peer owns.
      // Existing distinct promotion supplies ONE locally executable canonical
      // item; its source mapping travels back through the same issue CDC.
      const parsed = parseIntakeDecision({ disposition: 'promote', reason: 'CSV failure reproduced upstream',
        reproduction: { kind: 'failing-test', ref: 'report-problem.integration.test.ts CSV reproduction', buildSha: 'abc1234def' },
        acceptance: { problem: 'CSV export crashes', evidence: ['CSV reproduction fails'],
          outcome: 'CSV export completes', scope: 'CSV export on board', completionCheck: 'CSV reproduction passes' } },
      { decidedBy: 'su-upstream-verifier', sourceRevision: await currentIntakeSourceRevision(id) });
      if (!parsed.ok) throw new Error(parsed.error);
      const promoted = await executeIntakeDecision({ sourceId: id, decision: parsed.decision, runId: 'p015-upstream', itemId: `report-${s}` });
      expect(promoted, JSON.stringify(promoted)).toMatchObject({ ok: true, mode: 'distinct', created: true });
      if (!promoted.ok || !promoted.workItemId) throw new Error(JSON.stringify(promoted));
      expect(await claimIssue(promoted.workItemId, 'su-upstream-fixer')).toMatchObject({ assignee: 'su-upstream-fixer' });
      expect(await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-other', text: 'Which file?' })).toMatchObject({ ok: false });
      const question = await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-upstream-fixer', text: 'Which CSV file triggers it?' });
      expect(question).toMatchObject({ ok: true });
      expect(await askReporterQuestion({ id: promoted.workItemId, harness: 'papercusp', actor: 'su-upstream-fixer', text: 'A second question?' })).toMatchObject({ ok: false, error: 'report-already-has-follow-up-question' });
      const [returnOp] = await upstreamDb.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${upstreamWorkspace} AND table_name = 'engineer_issues'
           AND row->>'issue_id' = ${promoted.workItemId} ORDER BY id DESC LIMIT 1`;
      expect(returnOp).toBeDefined();
      const installedProjection = buildEngineerIssuesProjection({ workspaceId: WORKSPACE, harnessSlug: 'papercusp', sql: db.adminSql });
      await installedProjection.writeToPg(returnOp!.row, { ts: Number(returnOp!.ts), origin: 'remote', authorPubkey: 'p015-canonical-upstream' });
      const [received] = await db.adminSql<{ origin: string; taken_by: string; payload: Record<string, unknown> }[]>`
        SELECT origin, taken_by, payload FROM harness_shared.work_items
         WHERE workspace_id = ${WORKSPACE} AND feature_id = ${promoted.workItemId}`;
      expect(received).toMatchObject({ origin: 'remote', taken_by: 'su-upstream-fixer', payload: {
        intakeSource: { id }, reporterKinds: expect.arrayContaining(['end-user']) } });
      expect(JSON.stringify(received?.payload.reportContext)).toContain('0.9.4');
      const [original] = await db.adminSql<{ origin: string }[]>`
        SELECT origin FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE} AND feature_id = ${id}`;
      expect(original?.origin).toBe('local');
      const status = await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql);
      expect(status).toMatchObject({ canonicalId: promoted.workItemId, status: 'being-fixed', followUp: { question: { text: 'Which CSV file triggers it?' } } });
      const questionId = status!.followUp!.question.id;
      h.sql = db.adminSql;
      const reply = { operation: 'answer-follow-up', id, harness: 'papercusp', questionId, text: 'The UTF-8 sample from the export panel.' };
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp(reply))).toMatchObject({ status: 200 });
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp(reply))).toMatchObject({ status: 409, body: { error: 'question-already-answered' } });
      expect(await runWithWorkspace(WORKSPACE, () => answerReportFollowUp({ ...reply, id: promoted.workItemId }))).toMatchObject({ status: 404 });
      const [answerOp] = await db.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox WHERE workspace_id = ${WORKSPACE}
          AND table_name = 'engineer_issues' AND row->>'issue_id' = ${id} ORDER BY id DESC LIMIT 1`;
      expect(answerOp?.row.payload).toMatchObject({ reporterAnswer: { questionId, text: reply.text } });
      await projection.writeToPg(answerOp!.row, { ts: Number(answerOp!.ts), origin: 'remote', authorPubkey: 'p015-admitted-install' });
      const [returnedAnswer] = await upstreamDb.adminSql<{ origin: string; answer: unknown }[]>`
        SELECT origin, payload->'reporterAnswer' AS answer FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(returnedAnswer).toMatchObject({ origin: 'remote', answer: { questionId, text: reply.text } });

      // P016 publication contract: the real canonical writer emits a receipt
      // through issue CDC, and the installed source reads the canonical version.
      // Fixture completion is explicit; this is not a release/deploy operation.
      h.sql = upstreamDb.adminSql;
      const fixBlob = 'b'.repeat(40);
      await upstreamDb.adminSql`UPDATE harness_shared.work_items
        SET status = 'done', authority = 'committed', terminal_completion_ref = 'p016-publication-fixture',
            payload = payload || ${JSON.stringify({ _completionEvidence: { settlementManifest: {
              repositoryRoot: '/p016-fixture', contentIdentity: [{ path: 'src/export.ts', headBlobSha: fixBlob, workingTreeBlobSha: fixBlob }],
            } } })}::jsonb
        WHERE workspace_id = ${WORKSPACE} AND feature_id = ${promoted.workItemId}`;
      const release = { version: '0.9.5', channel: 'alpha', cutAt: new Date(), publishedAt: null as Date | null,
        changelogMd: null, workItemIds: [promoted.workItemId], planSlugs: [], artifacts: [],
        gitSha: 'a'.repeat(40), cutBy: null, notes: null };
      const publicationDeps = { ...defaultReporterReleaseDeps(upstreamDb.adminSql, WORKSPACE, release),
        repositoryRoot: '/p016-fixture',
        readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: fixBlob }]]),
      };
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
      release.publishedAt = new Date();
      expect(await publishReporterRelease(release, { ...publicationDeps,
        readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: 'c'.repeat(40) }]]),
      })).toEqual({ notified: [], unconfirmed: [promoted.workItemId] });
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [promoted.workItemId], unconfirmed: [] });
      expect(await publishReporterRelease(release, publicationDeps)).toEqual({ notified: [], unconfirmed: [] });
      const [releaseOp] = await upstreamDb.adminSql<{ row: EngineerIssueRow; ts: string | number }[]>`
        SELECT row, ts FROM harness_shared.substrate_outbox WHERE workspace_id = ${WORKSPACE}
          AND table_name = 'engineer_issues' AND row->>'issue_id' = ${promoted.workItemId} ORDER BY id DESC LIMIT 1`;
      expect(releaseOp?.row.payload).toMatchObject({ reporterRelease: { version: '0.9.5', completionRef: 'p016-publication-fixture' } });
      await installedProjection.writeToPg(releaseOp!.row, { ts: Number(releaseOp!.ts), origin: 'remote', authorPubkey: 'p015-canonical-upstream' });
      expect(await readReporterStatus({ id, harness: 'papercusp', workspaceId: WORKSPACE }, db.adminSql))
        .toMatchObject({ canonicalId: promoted.workItemId, status: 'fixed', label: 'Fixed in v0.9.5' });
      const [stillLocal] = await db.adminSql<{ origin: string }[]>`SELECT origin FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(stillLocal?.origin).toBe('local');
    } finally {
      h.sql = db.adminSql;
    }
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
