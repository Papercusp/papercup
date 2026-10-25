import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import type { SqlToolCandidateScore } from './sql-tool-candidate-score';
import type { SqlToolRecommendation } from './bash-substitution/sql-tool-recommendations';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async orig => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
const { captureImprovement } = await import('./harness/improvements/capture-core');
const { createIssue } = await import('./issues-engineer');
const { enterAgentReview } = await import('./harness/improvements/agent-review');
const { getWorkItem } = await import('./work-items');
const { submitSqlCandidateReview } = await import('./sql-tool-candidate-review');
const WS = 'sql-review-fixture', HARNESS = 'papercusp';
let db: OrgTestDb;
const priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  const migration = new URL('../../../libs/papercusp/libs/db/sql/1579-sql-candidate-review-lifecycle.sql', import.meta.url);
  // Drafts are exercised before arming; armed migrations are already in the fixture template.
  if (!existsSync(migration)) await db.adminSql.unsafe(readFileSync(new URL(migration.href + '.DRAFT'), 'utf8'));
}, 180_000);
afterAll(async () => {
  if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
  await db?.cleanup();
});
beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.sql_candidate_reviews`;
  await db.adminSql`DELETE FROM harness_shared.scout_routed_ideas WHERE workspace_id=${WS}`;
  await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS}`;
});
const candidate = (): SqlToolCandidateScore => ({
  id: 'opaque-candidate', workspaceToken: 'ws-token', harnessToken: 'h-token', boundaryToken: 'boundary',
  fingerprint: 'opaque-shape', parserVersion: 'v1', policyVersion: 'sql-demand-score-v1',
  eligible: true, reasons: [], score: .8, components: [], counts: { ok: 12, error: 0, refused: 0, unknown: 0 },
  verifiedAgents: 3, activeDays: ['2026-10-23', '2026-10-24'],
  observedCost: { measuredCalls: 12, totalMs: 120, meanMs: 10, unit: 'dispatch-wall-ms' },
});
const input = () => ({ workspaceId: WS, harnessSlug: HARNESS, submittedBy: 'su-sql-filer',
  candidate: candidate(), contractRef: 'contract-v1' });
const capture = vi.fn(async (value: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(value, { searchIssues: async () => [], createIssue }));
const enroll = vi.fn(enterAgentReview);
const deps = () => ({ client: db.adminSql, capture, enroll });
const recommendation = (kind: SqlToolRecommendation['kind']): SqlToolRecommendation => ({
  kind, reason: 'maintained-fixture', toolName: null, immediatelyCallable: false,
  fingerprint: 'opaque-shape', requiredFeatures: null, evidenceRefs: [], missingFeatures: [],
});
it('reuses actual canonical intake and post-review ownership on repeated cycles R5-CONTRACT OUTCOME-P-006', async () => {
  capture.mockClear(); enroll.mockClear();
  const first = await submitSqlCandidateReview(input(), deps());
  expect(first).toMatchObject({ status: 'pending', queue: 'agent-review', owner: null });
  const item = await getWorkItem(first.workItemId!, HARNESS);
  expect(item).toMatchObject({ state: 'open', assignee: null, payload: {
    agentReview: { status: 'pending', submittedBy: 'su-sql-filer' },
  } });
  expect(capture.mock.calls[0]![0].assignee).toBe('su-sql-filer');
  expect(await submitSqlCandidateReview({ ...input(), candidate: { ...candidate(), counts: {
    ok: 100, error: 0, refused: 0, unknown: 0 } } }, deps())).toEqual(first);
  expect(capture).toHaveBeenCalledTimes(1); expect(enroll).toHaveBeenCalledTimes(1);
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(1);
  const ledger = await db.adminSql`SELECT routed_ref FROM harness_shared.scout_routed_ideas WHERE workspace_id=${WS}`;
  expect(ledger).toHaveLength(1); expect(ledger[0]!.routed_ref).toBe('wi:' + first.workItemId);
});
it('unchanged declined editions stay declined; changed contracts reopen for review R5-CONTRACT OUTCOME-P-006', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  await db.adminSql`UPDATE harness_shared.work_items SET status='dropped', taken_by=NULL
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'declined', workItemId: first.workItemId });
  const changed = await submitSqlCandidateReview({ ...input(), contractRef: 'contract-v2' }, deps());
  expect(changed).toMatchObject({ status: 'pending', owner: null, lifecycleId: first.lifecycleId });
  expect(changed.workItemId).not.toBe(first.workItemId); expect(changed.editionId).not.toBe(first.editionId);
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(2);
});
it('accepted ownership is read from the current review item R5-CONTRACT', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  // Model the authoritative state left by the independent review workflow.
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-implementer',
    payload=jsonb_set(payload,'{agentReview,status}','"approved"'::jsonb)
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({
    status: 'accepted', workItemId: first.workItemId, queue: 'implementation', owner: 'su-implementer',
  });
});
it('suppressed and ineligible candidates never file work R5-CONTRACT', async () => {
  capture.mockClear();
  expect(await submitSqlCandidateReview({ ...input(), recommendation: recommendation('keep-sql') }, deps()))
    .toMatchObject({ status: 'suppressed', workItemId: null });
  expect(await submitSqlCandidateReview({ ...input(), recommendation: recommendation('keep-sql') }, deps()))
    .toMatchObject({ status: 'suppressed', workItemId: null });
  expect(await submitSqlCandidateReview({ ...input(), candidate: { ...candidate(), eligible: false } }, deps()))
    .toMatchObject({ status: 'ineligible' });
  expect(capture).not.toHaveBeenCalled();
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(0);
});
it('a crash after reservation resumes the same actual intake R5-CONTRACT', async () => {
  const fail = vi.fn(async () => { throw new Error('interrupted before capture'); });
  await expect(submitSqlCandidateReview(input(), { ...deps(), capture: fail })).rejects.toThrow('interrupted');
  const [reserved] = await db.adminSql`SELECT artifact_id FROM harness_shared.sql_candidate_reviews`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', workItemId: reserved!.artifact_id });
});
it('pending enrollment retries filer release without releasing a reviewer R5-CONTRACT', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  // Partial enrollment has committed its payload but has not released the filer yet.
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-sql-filer'
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', owner: null });
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-independent-reviewer'
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', owner: 'su-independent-reviewer' });
});
