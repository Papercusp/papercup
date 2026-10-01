import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { humanAssignee, readHumanMarketJob } from './work-items-human-market';

const dbHandle = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const receipts = vi.hoisted(() => ({ workspace: vi.fn(), rubric: vi.fn(), evidence: vi.fn(), eligibility: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: dbHandle.sql }),
}));
vi.mock('./issues-engineer', async orig => ({ ...await orig<typeof import('./issues-engineer')>(),
  issuesScopeWorkspace: receipts.workspace }));
vi.mock('./rubrics', async orig => ({ ...await orig<typeof import('./rubrics')>(), getRubric: receipts.rubric }));
vi.mock('./scorecards', async orig => ({ ...await orig<typeof import('./scorecards')>(), readScorecardEvidence: receipts.evidence }));
vi.mock('./agent-tools/scorecards/grader-eligibility', () => ({ resolveAcceptanceGraderEligibility: receipts.eligibility }));
const store = await import('./work-items-human-market-store');
const owner = '00000000-0000-4000-8000-000000000001';
const human = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const scope = { workspaceId: 'default', harness: 'pilot', id: 'WI-pilot' };
const job = {
  route: 'market', version: 0, ownerUserId: owner, brief: 'Review public onboarding.',
  rubricRef: 'review@1', amountCents: 500, currency: 'USD',
  rubricRevision: 1, rubricCriteriaHash: 'a'.repeat(64),
};
let db: FreshPgDb;
// Hold the row until every adapter has read the old offer and reached UPDATE.
// This makes the CAS test exercise a real stale-read race, not lucky scheduling.
async function withBlockedWrites<T>(count: number, start: () => Promise<T>, changeTerms = false): Promise<T> {
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = db.sql.begin(async tx => {
    await tx`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = 'WI-pilot' FOR UPDATE`;
    ready();
    await released;
    if (changeTerms) await tx`UPDATE harness_shared.work_items SET payload =
      jsonb_set(payload, '{humanWork,amountCents}', '900'::jsonb) WHERE feature_id = 'WI-pilot'`;
  });
  await locked;
  const work = start();
  // Observe rejections immediately even if the precondition check fails.
  void work.catch(() => undefined);
  try {
    await vi.waitFor(async () => {
      const waiting = await db.sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%UPDATE harness_shared.work_items%'`;
      expect(waiting[0].n).toBe(count);
    }, { timeout: 5000, interval: 20 });
  } finally {
    release();
    await blocker;
  }
  return work;
}
beforeAll(async () => {
  db = await createFreshPgDb('human-market');
  dbHandle.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
});
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  vi.clearAllMocks();
  receipts.workspace.mockReturnValue(scope.workspaceId);
  receipts.rubric.mockResolvedValue({ rubricId: job.rubricRef, workspaceId: scope.workspaceId,
    kind: 'standard', status: 'active', revision: 1, criteriaHash: job.rubricCriteriaHash });
  receipts.eligibility.mockResolvedValue({ callerIsImplementer: false, refusal: null });
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload)
    VALUES ('default', 'pilot', 'WI-pilot', 'task', 'needs-human', 'admitted', 'Internal title', 'Internal summary',
      ${JSON.stringify({ humanWork: job, _ei: { severity: 'low' }, internalSecret: 'private' })}::text::jsonb)`;
  // postgres-js serializes a string bound directly as jsonb a second time.
  // Assert the real storage shape before testing the adapter's predicates.
  const shape = await db.sql`SELECT jsonb_typeof(payload) AS kind FROM harness_shared.work_items`;
  expect(shape[0].kind).toBe('object');
});

async function submittedWithCard() {
  await store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' });
  const row = await store.actOnHumanMarketItem({ ...scope, userId: human, version: 1, action: 'submit', result: 'Reviewed.' });
  const submission = readHumanMarketJob(row)!.submission!;
  const card = { issueId: 'EI-grade', createdBy: 'su-unrelated', createdAt: new Date().toISOString(),
    rubricRef: job.rubricRef, rubricRevision: 1, criteriaHash: job.rubricCriteriaHash,
    subject: { kind: 'work-item', ref: scope.id }, rubricResolved: true, missingKeys: [], extraKeys: [],
    synthesized: false, auditTarget: { current: true },
    criteria: [{ key: 'review', rating: 'pass', evidence: `Read the result; submission-sha256:${submission.sha256}` }] };
  receipts.evidence.mockResolvedValue({ kind: 'found', scorecard: card });
  return card;
}

describe('human market canonical persistence', () => {
  it('persists the claim and immutable submission, preserves internal payload and stamps claim identity', async () => {
    const claimed = await store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' });
    expect(claimed).toMatchObject({ state: 'wip', assignee: humanAssignee(human) });
    expect(claimed.payload).toMatchObject({ internalSecret: 'private', _ei: { severity: 'low' },
      _claimSubjectBaseline: { kind: 'task', title: 'Internal title', summary: 'Internal summary' } });
    const submitted = await store.actOnHumanMarketItem({ ...scope, userId: human, version: 1, action: 'submit', result: 'Reviewed.' });
    expect(readHumanMarketJob(submitted)).toMatchObject({ version: 2, submission: { result: 'Reviewed.' } });
    const reread = await store.getHumanMarketItem(scope);
    expect(reread).toEqual(submitted);
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 2, action: 'submit', result: 'Changed.' }))
      .rejects.toThrow('submission_already_recorded');
  });

  it('allows exactly one concurrent claimant and rejects stale displayed terms', async () => {
    const results = await withBlockedWrites(2, () => Promise.allSettled([human, other].map(userId =>
      store.actOnHumanMarketItem({ ...scope, userId, version: 0, action: 'claim' }))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(readHumanMarketJob((await store.getHumanMarketItem(scope))!)?.version).toBe(1);
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' }))
      .rejects.toThrow('market_offer_changed');
  });

  it('compares the full offer even when terms change without a version bump', async () => {
    const results = await withBlockedWrites(1, () => Promise.allSettled([
      store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' }),
    ]), true);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('market_offer_changed') });
    const row = await store.getHumanMarketItem(scope);
    expect(row?.assignee).toBeNull();
    expect(readHumanMarketJob(row!)?.amountCents).toBe(900);
  });

  it('cannot cross workspace/harness boundaries, agent claims, pending admission, remote origin or claim holds', async () => {
    expect(await store.getHumanMarketItem({ ...scope, workspaceId: 'other' })).toBeNull();
    expect(await store.getHumanMarketItem({ ...scope, harness: 'other' })).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-worker'`;
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' })).rejects.toThrow('claim_conflict');
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, admission = 'pending'`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted', origin = 'remote'`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET origin = 'local', payload = payload || '{"_claimHold":true}'::jsonb`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
  });

  it('rejects owner and non-human identities before any mutation', async () => {
    for (const userId of [owner, 'su-agent']) {
      await expect(store.actOnHumanMarketItem({ ...scope, userId, version: 0, action: 'claim' })).rejects.toThrow();
    }
    expect((await store.getHumanMarketItem(scope))?.assignee).toBeNull();
  });

  it('persists only an authoritative exact-submission grade and the owner-attested agreed payment', async () => {
    await submittedWithCard();
    const graded = await store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' });
    expect(receipts.evidence).toHaveBeenCalledWith('EI-grade');
    expect(readHumanMarketJob(graded)).toMatchObject({ version: 3, grade: { scorecardRef: 'EI-grade', passed: true, graderId: 'su-unrelated' } });
    const paid = await store.reviewHumanMarketItem({ ...scope, userId: owner, version: 3, action: 'payment', receiptRef: 'bank:actual-receipt' });
    expect(readHumanMarketJob(paid)).toMatchObject({ version: 4, payment: { paidBy: owner, amountCents: 500, currency: 'USD', receiptRef: 'bank:actual-receipt' } });
    expect(paid.payload.internalSecret).toBe('private');
    expect(await store.getHumanMarketItem(scope)).toEqual(paid);
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 4, action: 'payment', receiptRef: 'bank:duplicate' }))
      .rejects.toThrow('payment_already_recorded');
  });

  it('refuses a participant or other account before resolving grade/payment receipts', async () => {
    await submittedWithCard();
    for (const userId of [human, other, 'su-agent']) {
      await expect(store.reviewHumanMarketItem({ ...scope, userId, version: 2, action: 'grade', scorecardRef: 'EI-grade' }))
        .rejects.toThrow('market_owner_required');
    }
    expect(receipts.evidence).not.toHaveBeenCalled();
  });

  it.each(['subject', 'submission', 'rubric', 'rubric-revision', 'rubric-hash', 'creator', 'synthesized',
    'provisional', 'retracted', 'audit', 'missing', 'extra', 'empty', 'old', 'unknown'])(
    'rejects a %s mismatch rather than trusting a supplied passing card', async mismatch => {
      const card: Record<string, any> = await submittedWithCard();
      if (mismatch === 'subject') card.subject.ref = 'WI-another';
      if (mismatch === 'submission') card.criteria[0].evidence = 'A different submission passed.';
      if (mismatch === 'rubric') card.rubricRef = 'another';
      if (mismatch === 'rubric-revision') card.rubricRevision = 2;
      if (mismatch === 'rubric-hash') card.criteriaHash = 'b'.repeat(64);
      if (mismatch === 'creator') card.createdBy = human;
      if (mismatch === 'synthesized') card.synthesized = true;
      if (mismatch === 'provisional') card.provisional = { reason: 'working note' };
      if (mismatch === 'retracted') card.auditTarget.current = false;
      if (mismatch === 'audit') card.gradingAudit = { state: 'failed' };
      if (mismatch === 'missing') card.missingKeys = ['review'];
      if (mismatch === 'extra') card.extraKeys = ['invented'];
      if (mismatch === 'empty') card.criteria = [];
      if (mismatch === 'old') card.createdAt = '2020-01-01T00:00:00Z';
      if (mismatch === 'unknown') card.criteria[0].rating = 'unknown';
      receipts.evidence.mockResolvedValue({ kind: 'found', scorecard: card });
      await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' })).rejects.toThrow();
      expect(readHumanMarketJob((await store.getHumanMarketItem(scope))!)?.grade).toBeUndefined();
    },
  );

  it('uses the canonical acceptance-lineage preflight and refuses a related grader', async () => {
    await submittedWithCard();
    receipts.rubric.mockResolvedValue({ rubricId: job.rubricRef, workspaceId: scope.workspaceId,
      kind: 'acceptance', status: 'active', revision: 1, criteriaHash: job.rubricCriteriaHash });
    receipts.eligibility.mockResolvedValue({ callerIsImplementer: false, refusal: { code: 'grader_in_implementer_lineage' } });
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' }))
      .rejects.toThrow('market_grader_not_independent');
    expect(receipts.eligibility).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'su-unrelated', workspaceId: scope.workspaceId }));
  });

  it('prevents payment after a receipt is superseded', async () => {
    const card = await submittedWithCard();
    await store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' });
    receipts.evidence.mockResolvedValue({ kind: 'found', scorecard: { ...card, auditTarget: { current: false } } });
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 3, action: 'payment', receiptRef: 'bank:receipt' }))
      .rejects.toThrow('market_scorecard_mismatch');
    expect(readHumanMarketJob((await store.getHumanMarketItem(scope))!)?.payment).toBeUndefined();
  });

  it('records a failing grade but never accepts it for payment', async () => {
    const card = await submittedWithCard();
    card.criteria[0].rating = 'fail';
    const graded = await store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' });
    expect(readHumanMarketJob(graded)?.grade?.passed).toBe(false);
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 3, action: 'payment', receiptRef: 'bank:receipt' }))
      .rejects.toThrow('passing_grade_required');
  });

  it('refuses an ambient workspace mismatch or a changed live rubric', async () => {
    await submittedWithCard();
    receipts.workspace.mockReturnValue('another-workspace');
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' }))
      .rejects.toThrow('market_scope_required');
    expect(receipts.evidence).not.toHaveBeenCalled();
    receipts.workspace.mockReturnValue(scope.workspaceId);
    receipts.rubric.mockResolvedValue({ workspaceId: scope.workspaceId, status: 'active', revision: 2, criteriaHash: 'b'.repeat(64) });
    await expect(store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' }))
      .rejects.toThrow('market_scorecard_mismatch');
  });

  it('allows exactly one concurrent grade receipt', async () => {
    await submittedWithCard();
    const results = await withBlockedWrites(2, () => Promise.allSettled([1, 2].map(() =>
      store.reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: 'EI-grade' }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(readHumanMarketJob((await store.getHumanMarketItem(scope))!)?.version).toBe(3);
  });
});
