import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OwnerDirectiveRow } from '../../owner-directives';
import type { ReportRecord } from '../../report-library';
import type { SpecClauseRevision } from './spec-clauses-store';
import { computeSpecSetHash } from './spec-clause-compiler';
import { loadOwnerSelectedReview, ownerSelectedReviewSchema, verifyOwnerSelectedReview } from './plan-start-owner-review';

const scope = { workspaceId: 'workspace', harnessSlug: 'harness', planSlug: 'migration' };
const barSetHash = 'a'.repeat(64);
function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return { planSlug: scope.planSlug, specId: 'S-1', sourceValId: 'VAL-1', planItemId: 'P-001',
    currentRevision: 1, revision: 1, behavior: 'A valid download returns signed bytes', behaviorClass: 'happy-path',
    requiredEvidence: ['tree'], requiredTestLayers: ['unit'], mutationRequired: false, lifecycleStatus: 'active',
    supersedes: null, exemption: null, falsifier: { observation: 'Unsigned bytes were returned' },
    contentHash: 'source-hash', createdBy: 'implementer', createdAt: '2026-10-01T00:00:00Z',
    acceptedBy: null, acceptedAt: null, acceptanceRef: null,
    sourceBar: { barKey: 'R-1', barHash: 'bar-hash', barSetHash, rubricSlug: 'rubric', rubricRevision: 1, evidencePlane: 'tree' },
    ...over };
}
function fixture() {
  const reviewedClauses = [clause()];
  const specSetHash = computeSpecSetHash(reviewedClauses);
  const selectionText = 'Accept your review as adequate instead of the blocked critiques.';
  const reviewConclusion = 'APPROVE continued implementation with the recorded findings.';
  const bodyMd = `Review of migration\n${reviewConclusion}\nBAR set: ${barSetHash}\nSpec set: ${specSetHash}`;
  const bodySha256 = createHash('sha256').update(bodyMd).digest('hex');
  const directive: OwnerDirectiveRow = { id: 42, workspaceId: scope.workspaceId, ownerId: 'human',
    recordedBy: 'reviewer', capturedByHook: true, sourceTurnRef: 'session_turn:codex:original:6',
    sessionRef: 'original', verbatimText: selectionText, createdAtMs: Date.parse('2026-10-02T00:00:00Z'),
    dispositionedAtMs: null, dispositionStatus: null, dispositionNote: null, dispositionedBy: null };
  const report: ReportRecord = { workspaceId: scope.workspaceId, reportId: 'report', title: 'Independent review',
    summary: 'Approval', bodyMd, bodySha256, goalOwnerReport: null, kind: 'review',
    subject: { kind: 'plan', ref: scope.planSlug, label: null },
    origin: { harnessSlug: null, authorOwnerId: 'reviewer', authorSessionRef: 'original' }, visibility: 'workspace',
    supersedesReportId: null, lineageId: 'report', source: 'agent', tags: [],
    publishedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', retiredAt: null };
  return { scope, requestedBy: 'implementer', request: { directiveId: 42, reportId: 'report', bodySha256,
    barSetHash, specSetHash, selectionText, reviewConclusion, dispositions: 'All adverse findings accepted; final deployed acceptance remains required.' },
    directive, report, latestReportId: 'report', authorPartyKeys: new Set(['implementer', 'plan-author']),
    reviewerPartyKey: 'reviewer', reviewedClauses, currentClauses: reviewedClauses };
}

describe('owner-selected pre-implementation review', () => {
  it('records one real independent report and exact owner selection without inventing critic identities', () => {
    const input = fixture();
    const result = verifyOwnerSelectedReview(input);
    expect(result).toMatchObject({ ok: true, receipt: { scope, reviewerId: 'reviewer', requestedBy: 'implementer', request: input.request } });
    expect(JSON.stringify(result)).not.toContain('consultId');
  });
  it('retains semantic freshness across lifecycle/revision/acceptance administration', () => {
    const input = fixture();
    input.currentClauses = [clause({ revision: 2, lifecycleStatus: 'accepted', acceptedBy: 'new-acceptor' })];
    expect(verifyOwnerSelectedReview(input).ok).toBe(true);
  });
  it.each(['workspace', 'plan', 'harness', 'body', 'superseded', 'retired', 'conclusion'])(
    'refuses an incompatible %s source', kind => {
      const input = fixture();
      if (kind === 'workspace') input.report.workspaceId = 'elsewhere';
      if (kind === 'plan') input.report.subject.ref = 'another-plan';
      if (kind === 'harness') input.report.origin.harnessSlug = 'another-harness';
      if (kind === 'body') input.report.bodyMd += '\nEdited';
      if (kind === 'superseded') input.latestReportId = 'newer-report';
      if (kind === 'retired') input.report.retiredAt = '2026-10-04T00:00:00Z';
      if (kind === 'conclusion') input.request.reviewConclusion = 'A conclusion the reviewer did not write';
      expect(verifyOwnerSelectedReview(input).ok).toBe(false);
    },
  );
  it.each(['agent-copy', 'unknown-turn', 'foreign-workspace', 'declined', 'hidden-refusal', 'unrelated-turn', 'wrong-report'])(
    'refuses %s owner authority', kind => {
      const input = fixture();
      if (kind === 'agent-copy') input.directive.capturedByHook = false;
      if (kind === 'unknown-turn') input.directive.sourceTurnRef = null;
      if (kind === 'foreign-workspace') input.directive.workspaceId = 'other';
      if (kind === 'declined') input.directive.dispositionStatus = 'declined';
      if (kind === 'hidden-refusal') input.directive.verbatimText = `Do not ${input.request.selectionText}`;
      if (kind === 'unrelated-turn') input.directive.verbatimText = input.request.selectionText = 'Continue working on the implementation.';
      if (kind === 'wrong-report') input.directive.recordedBy = 'unrelated-reviewer';
      expect(verifyOwnerSelectedReview(input).ok).toBe(false);
    },
  );
  it('rejects a critic related to either the plan author or the implementation owner', () => {
    const input = fixture();
    input.reviewerPartyKey = 'plan-author';
    expect(verifyOwnerSelectedReview(input)).toEqual({ ok: false, reason: 'review_author_lineage' });
    input.reviewerPartyKey = 'implementer';
    expect(verifyOwnerSelectedReview(input).ok).toBe(false);
  });
  it.each(['behavior', 'falsifier', 'removed', 'new-clause', 'bar-set'])(
    'refuses a concurrent %s contract change', kind => {
      const input = fixture();
      if (kind === 'behavior') input.currentClauses = [clause({ behavior: 'Return any bytes' })];
      if (kind === 'falsifier') input.currentClauses = [clause({ falsifier: { observation: 'Something else' } })];
      if (kind === 'removed') input.currentClauses = [clause({ lifecycleStatus: 'superseded' })];
      if (kind === 'new-clause') input.currentClauses = [...input.currentClauses, clause({ specId: 'S-2' })];
      if (kind === 'bar-set') input.currentClauses = [clause({ sourceBar: { ...clause().sourceBar!, barSetHash: 'b'.repeat(64) } })];
      expect(verifyOwnerSelectedReview(input)).toEqual({ ok: false, reason: 'review_contract_stale' });
    },
  );
  it('preserves removed-clause dispositions and refuses their disappearance', () => {
    const input = fixture();
    const removed = clause({ specId: 'S-removed', lifecycleStatus: 'superseded' });
    input.reviewedClauses = [...input.reviewedClauses, removed];
    input.currentClauses = [...input.currentClauses, removed];
    expect(verifyOwnerSelectedReview(input).ok).toBe(true);
    input.currentClauses = [clause()];
    expect(verifyOwnerSelectedReview(input)).toEqual({ ok: false, reason: 'review_contract_stale' });
  });
  it('cannot attach an unpinned report to the current contract at registration time', () => {
    const input = fixture();
    input.reviewedClauses = [clause({ behavior: 'The report reviewed different behavior' })];
    expect(verifyOwnerSelectedReview(input)).toEqual({ ok: false, reason: 'review_contract_not_pinned' });
  });
  it('requires explicit conclusion and disposition evidence in the public request', () => {
    const { dispositions: _omit, ...request } = fixture().request;
    expect(ownerSelectedReviewSchema.safeParse(request).success).toBe(false);
  });
  it('does not resurrect an earlier receipt when the newest registration is malformed', async () => {
    const sql = (() => Promise.resolve([{ content_snapshot: '{broken' }])) as unknown as Sql;
    expect(await loadOwnerSelectedReview(scope, ['implementer'], sql)).toEqual({ ok: false, reason: 'review_receipt_invalid' });
  });
  it('propagates unavailable ledger reads instead of treating them as no selected review', async () => {
    const sql = (() => Promise.reject(new Error('ledger unavailable'))) as unknown as Sql;
    await expect(loadOwnerSelectedReview(scope, ['implementer'], sql)).rejects.toThrow('ledger unavailable');
  });
});
