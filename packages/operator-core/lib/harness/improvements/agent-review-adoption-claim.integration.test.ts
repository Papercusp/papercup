/**
 * BQL D-008 (bug-queue-legitimacy-and-actionable-validation-2026-10-10, P-002): revision
 * adoption through the REAL shared claim writer on a fully migrated Postgres.
 *
 * Why this file exists: agent-review-scope.integration.test.ts proves adopt-next's
 * discovery query, but it replaces `claimWorkItem` with a hand-written UPDATE. The real
 * writer's issue intake floor admits a revision-requested row only for its CURRENT payload
 * submitter, and adoption claims BEFORE it rebinds, so every live adoption was refused
 * (adopt-next on :3170: 0 of 25 adopted, 16 claim-refused) while that test stayed green.
 * Here the claim is the production claimWorkItem -> claimIssue path, so the floor and the
 * admission that lifts it are both exercised in SQL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  resolveSessionStates: vi.fn(async () => new Map()),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: h.resolveSessionStates,
}));

const { createIssue, claimIssue } = await import('../../issues-engineer');
const { claimWorkItem, getWorkItem, mergeWorkItemPayload, releaseWorkItem } = await import('../../work-items');
const { adoptAgentReviewRevision, correctAgentReview, readAgentReviewCorrectionBase } = await import('./agent-review');
const { recordRoutedIdea, gradeRoutedIdea } = await import('../../scout/routed-ledger');
const { requestAdmissionRecovery } = await import('../../work-item-admission-recovery');
const { cleanupReviewerCorrectionFixture } = await import('../../agent-tools/testing/record-run');
const { acceptanceSourceRevision, mintAgentReviewClaimAdmission, mintAgentReviewRevisionAdoptionAdmission,
  verificationConflict, verificationParties, readAgentReviewState, createImplementationReadiness } = await import('./agent-review-policy');

let db: OrgTestDb;

beforeAll(async () => {
  // Cheap precondition before starting the migrated PG matrix: pending review
  // must use the maintained registry's existing clearer, never an invented hold.
  expect(createImplementationReadiness({ status: 'unknown', source: 'agent-review', reason: 'awaiting-agent-review' }))
    .toMatchObject({ status: 'unknown', reason: 'awaiting-agent-review' });
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
  await db.adminSql`INSERT INTO harness_shared.operator_secrets (name, value_b64)
    VALUES ('spawn-signing-key', ${Buffer.alloc(32, 42).toString('base64')}) ON CONFLICT (name) DO NOTHING`;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// Full owner ids: a short su- prefix is expanded (or refused) by the claim writer's
// canonicalization before any floor runs, which would test the wrong thing.
const GONE = 'su-0a0a0a0a-1111-4222-8333-444444444444';
const ADOPTER = 'su-0b0b0b0b-1111-4222-8333-444444444444';
const OTHER = 'su-0c0c0c0c-1111-4222-8333-444444444444';

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Row {
  feature_id: string;
  workspace_id: string;
  harness_slug: string;
  taken_by: string | null;
  payload: Record<string, unknown> | null;
}

async function row(id: string): Promise<Row> {
  const [r] = await db.adminSql<Row[]>`
    SELECT feature_id, workspace_id, harness_slug, taken_by, payload
      FROM harness_shared.work_items WHERE feature_id = ${id}`;
  if (!r) throw new Error(`no work_items row for ${id}`);
  return r;
}

async function patchReview(id: string, review: Record<string, unknown>, takenBy: string | null = null) {
  await db.adminSql`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify({ agentReview: review })}::text::jsonb,
           taken_by = ${takenBy}
     WHERE feature_id = ${id}`;
}

/** An open bug whose round-2 CONTENT revision belongs to GONE (the adoptable class). */
async function contentRevision(t: string, takenBy: string | null = null, kind: 'bug' | 'change' = 'bug') {
  const issue = await createIssue({
    kind,
    title: `export retries drop the idempotency key ${t}`,
    body: `a retried export is written twice because the retry omits the idempotency key ${t}`,
    scope: 'harness:papercusp',
    createdBy: GONE,
  });
  await patchReview(issue.id, {
    status: 'revision-requested',
    submittedBy: GONE,
    ledgerIdeaId: `idea-${t}`,
    round: 2,
    revisionKind: 'content',
  }, takenBy);
  const r = await row(issue.id);
  return { id: issue.id, harness: r.harness_slug, workspace: r.workspace_id };
}

function adoptDeps() {
  return {
    getWorkItem,
    mergeWorkItemPayload,
    releaseWorkItem,
    claimWorkItem,
    // The adoption comment is not under test; the claim and the rebind are.
    getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
    commentWorkItem: vi.fn(async () => ({})),
    resolveSubmitterLiveness: vi.fn(async (ownerId: string) =>
      ({ sessionState: ownerId === GONE ? 'ended' : 'live' }) as const),
    resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    recordRoutedIdea: vi.fn(),
    resolveLedgerIdeaId: vi.fn(),
    readLedgerGrade: vi.fn(),
    deliverRevision: vi.fn(),
    healOwnNodeOrigin: vi.fn(),
  };
}

async function mintFor(id: string, adopter: string) {
  const r = await row(id);
  const review = readAgentReviewState(r.payload);
  if (!review) throw new Error(`${id} carries no agentReview state`);
  return mintAgentReviewRevisionAdoptionAdmission({ itemId: id, adopter, harnessSlug: r.harness_slug, review });
}

describe('reviewer-owned correction through real PostgreSQL and claim admission', () => {
  async function fixture(holder: string | null = ADOPTER, kind: 'bug' | 'change' = 'bug') {
    const seed = await contentRevision(tag(), holder, kind);
    const review = readAgentReviewState((await row(seed.id)).payload)!;
    await recordRoutedIdea({ ideaId: review.ledgerIdeaId, lens: 'agent-review', rail: 'improvement',
      routedRef: `wi:${seed.id}`, harnessSlug: seed.harness, workspaceId: seed.workspace,
      title: 'Original report', origin: 'agent-review', createdBy: GONE });
    await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_grade=2,
      human_feedback='Missing evidence',graded_by=${OTHER},graded_at='2026-11-15T00:00:00.000001Z'::timestamptz
      WHERE idea_id=${review.ledgerIdeaId}`;
    return seed;
  }
  async function request(seed: Awaited<ReturnType<typeof fixture>>, requestKey = tag()) {
    const base = await readAgentReviewCorrectionBase({ id: seed.id, harness: seed.harness, workspaceId: seed.workspace });
    if (!base.available) throw new Error(base.reason);
    return { id: seed.id, harness: seed.harness, workspaceId: seed.workspace, actor: ADOPTER,
      requestKey, expectedRound: base.round, correctionRevision: base.correctionRevision,
      correction: { classification: 'material' as const, notes: [{ kind: 'evidence' as const,
        outcome: 'available' as const, text: 'Current maintained regression reproduces the duplicate export.', ref: 'test:export-retry' }],
        changes: { title: 'Corrected export report', summary: 'The writer drops the request key between attempts.' } } };
  }
  async function snapshot(seed: Awaited<ReturnType<typeof fixture>>) {
    const [item] = await db.adminSql`SELECT to_jsonb(w) AS value FROM harness_shared.work_items w
      WHERE workspace_id=${seed.workspace} AND harness_slug=${seed.harness} AND feature_id=${seed.id}`;
    const ledger = await db.adminSql`SELECT to_jsonb(l) AS value FROM harness_shared.scout_routed_ideas l
      WHERE workspace_id=${seed.workspace} AND routed_ref=${`wi:${seed.id}`} ORDER BY idea_id`;
    return { item: item.value, ledger: ledger.map(r => r.value) };
  }

  async function heldRecovery(seed: Awaited<ReturnType<typeof fixture>>, target = ADOPTER) {
    const routineId = `reviewer-correction-promoter:${seed.workspace}`;
    await db.adminSql`INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, target_role, trigger_kind, trigger_config)
      VALUES (${routineId}, ${seed.workspace}, ${seed.harness}, 'work-item-admission-promoter',
        'system:work-item-admission-promoter', 'cron', '{"cron":"*/30 * * * *"}')
      ON CONFLICT (id) DO NOTHING`;
    // Only the authorization seam is replaced. Scope, request schema, signing,
    // serialization and the correction's verification all use production code.
    const result = await requestAdmissionRecovery({ workspaceId: seed.workspace,
      harnessSlug: seed.harness, workItemId: seed.id, caller: OTHER, target,
      authority: { kind: 'signed-spawn', role: 'reviewer', expiresAtSec: 0, credentialSha256: 'a'.repeat(64) },
    }, { authorize: async () => {} }, db.adminSql);
    const recovery = { ...result.request, state: 'held', stage: 'screen', reason: 'outside-mutation-scope' };
    await mergeWorkItemPayload(seed.id, { _admissionRecovery: recovery }, { harness: seed.harness });
    return recovery;
  }

  it('corrects a signed held recovery only as its retained reviewer, preserving execution reservation and independent grading', async () => {
    const seed = await fixture(ADOPTER, 'change');
    const recovery = await heldRecovery(seed);
    const input = await request(seed);
    const proposal = { problem: 'A retried export duplicates its write.', evidence: ['test:export-retry'],
      outcome: 'Retries preserve the original request key.', scope: 'Export retry writer.',
      completionCheck: 'The maintained retry regression passes.' };
    const correction = { ...input, correction: { ...input.correction,
      changes: { ...input.correction.changes, acceptance: proposal } } };
    const result = await correctAgentReview(correction);
    expect(result, JSON.stringify(result)).toMatchObject({ corrected: true, replayed: false });
    if (!result.corrected) return;
    const after = await snapshot(seed);
    expect(after.item).toMatchObject({ taken_by: null, payload: { _admissionRecovery: recovery,
      agentReview: { status: 'pending', round: 3, submittedBy: GONE, materialAuthors: [ADOPTER] },
      implementationReadiness: { status: 'unknown', evidence: { acceptance: proposal } } } });
    expect(after.item.payload._admissionRecovery).toEqual(recovery);
    expect(await correctAgentReview(correction)).toEqual({ ...result, replayed: true });
    expect(await snapshot(seed)).toEqual(after);
    expect(await correctAgentReview({ ...correction, expectedRound: 9 }))
      .toEqual({ corrected: false, reason: 'request-key-conflict' });
    expect(await snapshot(seed)).toEqual(after);
    expect(await claimWorkItem(seed.id, ADOPTER, { harness: seed.harness })).toBeNull();

    const candidate = (await getWorkItem(seed.id, seed.harness))!;
    expect(verificationConflict(verificationParties(candidate), ADOPTER)).not.toBeNull();
    const admission = mintAgentReviewClaimAdmission({ itemId: seed.id, reviewer: OTHER, harnessSlug: seed.harness,
      review: readAgentReviewState(candidate.payload)!, source: candidate, parties: verificationParties(candidate) });
    expect(admission).not.toBeNull();
    expect(await claimWorkItem(seed.id, OTHER, { harness: seed.harness, agentReviewAdmission: admission! })).not.toBeNull();
    const latest = (await getWorkItem(seed.id, seed.harness))!;
    const review = readAgentReviewState(latest.payload)!;
    const grade = { ideaId: review.ledgerIdeaId, grade: 5, gradedBy: OTHER,
      reviewFence: { workspaceId: seed.workspace, harness: seed.harness, workItemId: seed.id,
        round: review.round, sourceRevision: review.reviewedSourceRevision! } };
    expect(await gradeRoutedIdea({ ...grade, gradedBy: ADOPTER })).toMatchObject({ applied: false });
    expect(await gradeRoutedIdea(grade)).toEqual({ applied: true });
    expect((await row(seed.id)).payload?._admissionRecovery).toEqual(recovery);
  });

  it.each(['foreign-actor', 'foreign-target', 'unclaimed', 'queued', 'wrong-stage', 'legacy', 'signature',
    'malformed', 'claim-hold', 'legacy-claim-hold', 'admission-hold', 'owner-action', 'original-author'] as const)(
    'refuses a held recovery correction with %s without changing source, grade, custody or reservation', async fault => {
      const holder = fault === 'original-author' ? GONE : fault === 'foreign-target' ? OTHER : ADOPTER;
      const seed = await fixture(holder);
      const recovery = await heldRecovery(seed, holder);
      const patches: Partial<Record<typeof fault, Record<string, unknown>>> = {
        queued: { _admissionRecovery: { ...recovery, state: 'queued', stage: 'queued' } },
        'wrong-stage': { _admissionRecovery: { ...recovery, stage: 'assign' } },
        legacy: { _admissionRecovery: { ...recovery, version: 2, authority: undefined } },
        signature: { _admissionRecovery: { ...recovery, signature: '0'.repeat(64) } },
        malformed: { _admissionRecovery: { state: 'held', stage: 'screen' } },
        'claim-hold': { _claimHold: true }, 'legacy-claim-hold': { _claimHold: 'true' },
        'admission-hold': { admissionHold: { reason: 'current-policy' } }, 'owner-action': { needsOwnerAction: true },
      };
      if (patches[fault]) await mergeWorkItemPayload(seed.id, patches[fault]!, { harness: seed.harness });
      if (fault === 'unclaimed') await db.adminSql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id=${seed.id}`;
      if (fault === 'foreign-target') await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${ADOPTER} WHERE feature_id=${seed.id}`;
      const input = { ...await request(seed), actor: fault === 'original-author' ? GONE : fault === 'foreign-actor' ? OTHER : ADOPTER };
      const before = await snapshot(seed);
      const reason = fault === 'claim-hold' || fault === 'legacy-claim-hold' ? 'claim-held'
        : fault === 'owner-action' ? 'owner-capability'
        : fault === 'original-author' ? 'original-author-conflict' : 'queue-held';
      expect(await correctAgentReview(input)).toEqual({ corrected: false, reason });
      expect(await snapshot(seed)).toEqual(before);
    },
  );

  it('rejects recovery copied from another exact item and a rotated signing key', async () => {
    const first = await fixture(); const recovery = await heldRecovery(first);
    const second = await fixture();
    await mergeWorkItemPayload(second.id, { _admissionRecovery: recovery }, { harness: second.harness });
    const before = await snapshot(second);
    expect(await correctAgentReview(await request(second))).toEqual({ corrected: false, reason: 'queue-held' });
    expect(await snapshot(second)).toEqual(before);
    const [key] = await db.adminSql`SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key'`;
    try {
      const input = await request(first); const original = await snapshot(first);
      await db.adminSql`UPDATE harness_shared.operator_secrets SET value_b64=${Buffer.alloc(32, 43).toString('base64')}
        WHERE name='spawn-signing-key'`;
      expect(await correctAgentReview(input)).toEqual({ corrected: false, reason: 'queue-held' });
      expect(await snapshot(first)).toEqual(original);
    } finally {
      await db.adminSql`UPDATE harness_shared.operator_secrets SET value_b64=${key.value_b64} WHERE name='spawn-signing-key'`;
    }
  });

  it.each(['replacement', 'park'] as const)('fences held recovery %s after reading the correction base', async drift => {
    const seed = await fixture(); const recovery = await heldRecovery(seed); const input = await request(seed);
    await mergeWorkItemPayload(seed.id, drift === 'replacement'
      ? { _admissionRecovery: { ...recovery, target: OTHER } } : { admissionHold: true }, { harness: seed.harness });
    const before = await snapshot(seed);
    expect(await correctAgentReview(input)).toEqual({ corrected: false, reason: 'correction-base-stale' });
    expect(await snapshot(seed)).toEqual(before);
  });

  it.each([ADOPTER, null])('corrects content debt under custody %s without rebinding the original author', async holder => {
    const seed = await fixture(holder); const input = await request(seed); const before = await snapshot(seed);
    const result = await correctAgentReview(input);
    expect(result.corrected).toBe(true);
    if (!result.corrected) return;
    const persisted = await snapshot(seed);
    expect(persisted.item).toMatchObject({ title: input.correction.changes.title, summary: input.correction.changes.summary,
      taken_by: null, payload: { _ei: { created_by: GONE }, agentReview: {
        submittedBy: GONE, status: 'pending', round: 3, materialAuthors: [ADOPTER],
        correctionHistory: [{ actor: ADOPTER, classification: 'material',
          priorVerdict: { human_grade: 2, human_feedback: 'Missing evidence', graded_at: '2026-11-15T00:00:00.000001Z' },
          beforeSource: { kind: before.item.item_kind, title: before.item.title, summary: before.item.summary } }],
        correctionReceipts: [result.receipt],
      }, implementationReadiness: { status: 'unknown' } } });
    expect(persisted.ledger).toMatchObject([{ title: input.correction.changes.title, created_by: GONE,
      human_grade: null, human_feedback: null, graded_by: null, graded_at: null }]);
    const base = await readAgentReviewCorrectionBase({ id: seed.id, harness: seed.harness, workspaceId: seed.workspace });
    expect(base).toMatchObject({ available: true, correctionRevision: result.receipt.afterRevision, round: 3 });
  });

  it.each(['live', 'ended', 'unknown'].flatMap(filerState =>
    [ADOPTER, null].map(holder => ({ filerState, holder })),
  ))('corrects with original filer $filerState and custody $holder without a liveness prerequisite', async ({ filerState, holder }) => {
    // Control the canonical liveness seam, rather than inferring death from GONE's
    // name. Correction must succeed without consulting it in any of these states.
    h.resolveSessionStates.mockReset();
    h.resolveSessionStates.mockResolvedValue(new Map([[GONE, {
      sessionState: filerState === 'unknown' ? null : filerState,
    }]]));
    try {
      const seed = await fixture(holder);
      const input = await request(seed);
      const before = await snapshot(seed);
      const result = await correctAgentReview(input);
      expect(result).toMatchObject({ corrected: true, replayed: false });
      if (!result.corrected) return;

      const persisted = await snapshot(seed);
      expect(persisted.item).toMatchObject({
        title: input.correction.changes.title,
        summary: input.correction.changes.summary,
        taken_by: null,
        payload: { _ei: { created_by: GONE }, agentReview: {
          submittedBy: GONE, status: 'pending', round: 3, materialAuthors: [ADOPTER],
          correctionHistory: [{ actor: ADOPTER, classification: 'material',
            beforeSource: { kind: before.item.item_kind, title: before.item.title, summary: before.item.summary },
            priorVerdict: { human_grade: 2, human_feedback: 'Missing evidence' } }],
          correctionReceipts: [result.receipt],
        }, implementationReadiness: { status: 'unknown' } },
      });
      expect(persisted.ledger).toMatchObject([{
        title: input.correction.changes.title, created_by: GONE,
        human_grade: null, human_feedback: null, graded_by: null, graded_at: null,
      }]);
      const base = await readAgentReviewCorrectionBase({ id: seed.id, harness: seed.harness, workspaceId: seed.workspace });
      expect(base).toMatchObject({ available: true, round: 3, correctionRevision: result.receipt.afterRevision,
        item: { title: input.correction.changes.title, summary: input.correction.changes.summary } });
      expect(h.resolveSessionStates).not.toHaveBeenCalled();
    } finally {
      h.resolveSessionStates.mockReset();
    }
  });

  it('replays the entire historical receipt after a later round/custody change; changed requests conflict', async () => {
    const seed = await fixture(); const input = await request(seed);
    const first = await correctAgentReview(input); expect(first.corrected).toBe(true);
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${OTHER},
      payload=jsonb_set(payload,'{agentReview,round}','9') WHERE feature_id=${seed.id}`;
    const beforeReplay = await snapshot(seed);
    expect(await correctAgentReview(input)).toEqual({ ...first, replayed: true });
    expect(await snapshot(seed)).toEqual(beforeReplay);
    expect(await correctAgentReview({ ...input, expectedRound: 9 })).toEqual({ corrected: false, reason: 'request-key-conflict' });
    expect(await snapshot(seed)).toEqual(beforeReplay);
  });

  it('admits exactly one of two requests against one base', async () => {
    const seed = await fixture(); const a = await request(seed);
    const results = await Promise.all([correctAgentReview(a), correctAgentReview({ ...a, requestKey: tag() })]);
    expect(results.filter(result => result.corrected)).toHaveLength(1);
    expect(results.filter(result => !result.corrected)).toEqual([{ corrected: false, reason: 'correction-base-stale' }]);
    expect((await row(seed.id)).payload?.agentReview).toMatchObject({ round: 3, correctionHistory: [expect.any(Object)] });
  });

  it('fences a late ledger grade at the locked correction round and rejects unfenced review writes', async () => {
    const seed = await fixture();
    const original = (await getWorkItem(seed.id, seed.harness))!;
    const pending = { ...readAgentReviewState(original.payload)!, status: 'pending' as const,
      reviewedSourceRevision: acceptanceSourceRevision(original) };
    await patchReview(seed.id, pending, ADOPTER);
    const reviewFence = { workspaceId: seed.workspace, harness: seed.harness,
      workItemId: seed.id, round: pending.round, sourceRevision: pending.reviewedSourceRevision };
    const grade = { ideaId: pending.ledgerIdeaId, grade: 5, gradedBy: ADOPTER, reviewFence };
    expect(await gradeRoutedIdea(grade)).toEqual({ applied: true });
    const input = await request(seed);
    let lateGrade: ReturnType<typeof gradeRoutedIdea> | undefined;
    const correction = await correctAgentReview(input, { onWriteBoundary: async boundary => {
      if (boundary === 'item') lateGrade = gradeRoutedIdea(grade);
    } });
    expect(correction.corrected).toBe(true);
    const corrected = await snapshot(seed);
    expect(await lateGrade).toEqual({ applied: false, reason: 'agent-review-source-revision-stale' });
    expect(await gradeRoutedIdea({ ideaId: pending.ledgerIdeaId, grade: 5, gradedBy: OTHER }))
      .toEqual({ applied: false, reason: 'agent-review-source-revision-stale' });
    expect(await snapshot(seed)).toEqual(corrected);
    const candidate = (await getWorkItem(seed.id, seed.harness))!;
    const claimed = await claimWorkItem(seed.id, OTHER, { harness: seed.harness,
      agentReviewAdmission: mintAgentReviewClaimAdmission({
        itemId: seed.id, reviewer: OTHER, harnessSlug: seed.harness,
        review: readAgentReviewState(candidate.payload)!, source: candidate, parties: verificationParties(candidate),
      })! });
    expect(claimed).not.toBeNull();
    const latest = (await getWorkItem(seed.id, seed.harness))!;
    const latestReview = readAgentReviewState(latest.payload)!;
    expect(await gradeRoutedIdea({ ...grade, gradedBy: OTHER, reviewFence: {
      ...reviewFence, round: latestReview.round, sourceRevision: latestReview.reviewedSourceRevision!,
    } })).toEqual({ applied: true });
  });

  it.each(['review', 'source', 'custody'] as const)('refuses an old approval payload after %s changes', async changed => {
    const seed = await fixture();
    const original = (await getWorkItem(seed.id, seed.harness))!;
    const expectedAgentReview = (original.payload as Record<string, unknown>).agentReview;
    if (changed === 'review') await correctAgentReview(await request(seed));
    if (changed === 'source') await db.adminSql`UPDATE harness_shared.work_items SET title='Changed concurrently' WHERE feature_id=${seed.id}`;
    if (changed === 'custody') await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${OTHER} WHERE feature_id=${seed.id}`;
    const before = await snapshot(seed);
    expect(await mergeWorkItemPayload(seed.id, {
      agentReview: { ...readAgentReviewState(original.payload)!, status: 'approved' },
      implementationReadiness: createImplementationReadiness({ status: 'ready', source: 'agent-review', reason: 'agent-review-approved' }),
    }, { harness: seed.harness, expectedAgentReview,
      expectedSourceRevision: acceptanceSourceRevision(original), expectedCustodianId: original.assignee,
      requireNonTerminal: true })).toBeNull();
    expect(await snapshot(seed)).toEqual(before);
  });

  it.each(['source', 'proposal', 'context', 'evidence', 'consultation', 'unknown', 'identity',
    'material-authors', 'custody', 'hold', 'ledger-grade', 'ledger-feedback', 'ledger-author', 'future-payload'] as const)(
    'the real correction CAS includes %s changes after pickup', async changed => {
      const seed = await fixture(); const input = await request(seed);
      const patch: Record<string, unknown> = {
        proposal: { implementationReadiness: { status: 'unknown', evidence: { acceptance: { outcome: 'new proposal' } } } },
        context: { context: ['different context'] }, evidence: { evidence: [{ ref: 'test_runs:9', outcome: 'missing' }] },
        consultation: { consultation: { outcome: 'inaccessible', ref: 'conversation:private-gap' } },
        unknown: { unknownOutcome: null }, 'future-payload': { futurePayload: { nested: [null, '', 'kept'] } },
      };
      if (patch[changed]) await mergeWorkItemPayload(seed.id, patch[changed] as Record<string, unknown>, { harness: seed.harness });
      if (changed === 'source') await db.adminSql`UPDATE harness_shared.work_items SET title='Concurrent source' WHERE feature_id=${seed.id}`;
      if (changed === 'identity') await db.adminSql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload,'{_ei,created_by}',${JSON.stringify(OTHER)}::jsonb) WHERE feature_id=${seed.id}`;
      if (changed === 'material-authors') await db.adminSql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload,'{agentReview,materialAuthors}',${JSON.stringify([OTHER])}::jsonb) WHERE feature_id=${seed.id}`;
      if (changed === 'custody') await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${OTHER} WHERE feature_id=${seed.id}`;
      if (changed === 'hold') await mergeWorkItemPayload(seed.id, { _claimHold: true }, { harness: seed.harness });
      if (changed === 'ledger-grade') await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_grade=4 WHERE routed_ref=${`wi:${seed.id}`}`;
      if (changed === 'ledger-feedback') await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_feedback='Concurrent critique' WHERE routed_ref=${`wi:${seed.id}`}`;
      if (changed === 'ledger-author') await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET created_by=${OTHER} WHERE routed_ref=${`wi:${seed.id}`}`;
      const before = await snapshot(seed);
      expect(await correctAgentReview(input)).toEqual({ corrected: false, reason: 'correction-base-stale' });
      expect(await snapshot(seed)).toEqual(before);
    },
  );

  it('clarification preserves original source, evidence and separate unavailable outcomes under the reviewer claim', async () => {
    const seed = await fixture(); const original = await snapshot(seed);
    const input = await request(seed);
    const notes = [
      { kind: 'transcript' as const, outcome: 'missing' as const, text: 'No source turn was retained.' },
      { kind: 'transcript' as const, outcome: 'inaccessible' as const, text: 'Archive access was refused.' },
      { kind: 'consultation' as const, outcome: 'unavailable' as const, text: 'No qualified answer was available.' },
      { kind: 'evidence' as const, outcome: 'unknown' as const, text: 'Reproduction remains unmeasured.' },
    ];
    const result = await correctAgentReview({ ...input, correction: { classification: 'clarification', notes } });
    expect(result.corrected).toBe(true);
    const after = await snapshot(seed);
    expect(after.item).toMatchObject({ title: original.item.title, summary: original.item.summary, taken_by: ADOPTER,
      payload: { _ei: { created_by: GONE }, agentReview: { submittedBy: GONE, materialAuthors: [],
        correctionContext: notes, reviewedSourceRevision: acceptanceSourceRevision((await getWorkItem(seed.id, seed.harness))!) } } });
    expect(after.item.payload.intakeReproduction).toEqual(original.item.payload.intakeReproduction);
    expect(after.item.payload.agentReview.correctionHistory[0].priorVerdict.human_feedback).toBe('Missing evidence');
    expect(after.ledger[0].created_by).toBe(GONE);
    expect(after.ledger[0].human_grade).toBeNull();
  });

  it('retains every material author across A then B then clarification; all approval predicates exclude them', async () => {
    const seed = await fixture();
    expect((await correctAgentReview(await request(seed))).corrected).toBe(true);
    const take = async (reviewer: string) => {
      const candidate = (await getWorkItem(seed.id, seed.harness))!;
      return claimWorkItem(seed.id, reviewer, { harness: seed.harness, agentReviewAdmission:
        mintAgentReviewClaimAdmission({ itemId: seed.id, reviewer, harnessSlug: seed.harness,
          review: readAgentReviewState(candidate.payload)!, source: candidate, parties: verificationParties(candidate) })! });
    };
    expect(await take(OTHER)).not.toBeNull();
    expect((await correctAgentReview({ ...await request(seed), actor: OTHER,
      correction: { classification: 'material', notes: [], changes: { summary: 'Second material diagnosis.' } } })).corrected).toBe(true);
    const third = 'su-0d0d0d0d-1111-4222-8333-444444444444';
    expect(await take(third)).not.toBeNull();
    expect((await correctAgentReview({ ...await request(seed), actor: third,
      correction: { classification: 'clarification', notes: [{ kind: 'context', outcome: 'unknown', text: 'Still unmeasured.' }] } })).corrected).toBe(true);
    const latest = (await getWorkItem(seed.id, seed.harness))!;
    expect(readAgentReviewState(latest.payload)).toMatchObject({ submittedBy: GONE, materialAuthors: [ADOPTER, OTHER],
      correctionHistory: [{ actor: ADOPTER }, { actor: OTHER }, { actor: third }] });
    for (const actor of [ADOPTER, OTHER]) {
      expect(verificationConflict(verificationParties(latest), actor)).not.toBeNull();
      expect(await gradeRoutedIdea({ ideaId: readAgentReviewState(latest.payload)!.ledgerIdeaId, grade: 5, gradedBy: actor,
        reviewFence: { workspaceId: seed.workspace, harness: seed.harness, workItemId: seed.id,
          round: readAgentReviewState(latest.payload)!.round, sourceRevision: acceptanceSourceRevision(latest) } }))
        .toEqual({ applied: false, reason: 'agent-review-source-revision-stale' });
    }
    expect(verificationConflict(verificationParties(latest), third)).toBeNull();
  });

  it.each(['workspace', 'harness'] as const)('refuses wrong %s scope without writing the private item', async changed => {
    const seed = await fixture(); const input = await request(seed); const before = await snapshot(seed);
    expect((await correctAgentReview({ ...input, ...(changed === 'workspace'
      ? { workspaceId: seed.workspace + '-other' } : { harness: seed.harness + '-other' }) })).corrected).toBe(false);
    expect(await snapshot(seed)).toEqual(before);
  });

  it.each(['claim', 'ledger', 'item', 'receipt'] as const)('rolls back the complete canonical population after %s failure', async boundary => {
    const seed = await fixture(null); const input = await request(seed); const before = await snapshot(seed);
    await expect(correctAgentReview(input, { onWriteBoundary: async at => {
      if (at === boundary) throw new Error(`injected-${at}`);
    } })).rejects.toThrow(`injected-${boundary}`);
    expect(await snapshot(seed)).toEqual(before);
    // The failed transaction must not reserve the request key either.
    expect((await correctAgentReview(input)).corrected).toBe(true);
  });

  it.each(['peer', 'hold', 'closed', 'owner', 'identity', 'association', 'reproduction'] as const)(
    'refuses %s prerequisites without changing any canonical owner', async condition => {
      const seed = await fixture();
      if (condition === 'peer') await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${OTHER} WHERE feature_id=${seed.id}`;
      if (condition === 'hold') await mergeWorkItemPayload(seed.id, { _claimHold: true }, { harness: seed.harness });
      if (condition === 'closed') await db.adminSql`UPDATE harness_shared.work_items SET status='closed' WHERE feature_id=${seed.id}`;
      if (condition === 'owner') await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET graded_by='owner' WHERE routed_ref=${`wi:${seed.id}`}`;
      if (condition === 'identity') await db.adminSql`UPDATE harness_shared.work_items SET payload=payload #- '{_ei,created_by}' WHERE feature_id=${seed.id}`;
      if (condition === 'reproduction') await db.adminSql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload,'{agentReview,revisionKind}','"reproduction"') WHERE feature_id=${seed.id}`;
      const input = await request(seed);
      if (condition === 'association') await db.adminSql`DELETE FROM harness_shared.scout_routed_ideas WHERE routed_ref=${`wi:${seed.id}`}`;
      const before = await snapshot(seed);
      expect((await correctAgentReview(input)).corrected).toBe(false);
      expect(await snapshot(seed)).toEqual(before);
    },
  );
});

describe('native reviewer correction fixture cleanup through real PostgreSQL', () => {
  async function seed() {
    const nonce = tag();
    const issue = await createIssue({ kind: 'change', title: 'Disposable reviewer correction control',
      scope: 'harness:papercusp', createdBy: GONE,
      payload: { reviewerCorrectionFixture: nonce } });
    const stored = await row(issue.id);
    const ideaId = `reviewer-correction:${nonce}`;
    await recordRoutedIdea({ ideaId, lens: 'agent-review', rail: 'improvement', routedRef: `wi:${issue.id}`,
      workspaceId: stored.workspace_id, harnessSlug: stored.harness_slug, title: issue.title,
      origin: 'agent-review', createdBy: GONE });
    return { id: issue.id, nonce, ideaId,
      ctx: { workspaceId: stored.workspace_id, harnessSlug: stored.harness_slug } };
  }

  it('removes the canonical change fixture and its ledger while retaining another fixture', async () => {
    const own = await seed(); const other = await seed();
    await cleanupReviewerCorrectionFixture(own.ctx, own.nonce, own.id, own.ideaId);
    expect(await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE feature_id=${own.id}`).toHaveLength(0);
    expect(await db.adminSql`SELECT idea_id FROM harness_shared.scout_routed_ideas WHERE idea_id=${own.ideaId}`).toHaveLength(0);
    expect((await row(other.id)).payload).toMatchObject({ reviewerCorrectionFixture: other.nonce });
    expect(await db.adminSql`SELECT idea_id FROM harness_shared.scout_routed_ideas WHERE idea_id=${other.ideaId}`).toHaveLength(1);
    await cleanupReviewerCorrectionFixture(other.ctx, other.nonce, other.id, other.ideaId);
  });

  it.each(['nonce', 'workspace', 'harness', 'idea'] as const)('refuses a wrong %s before deleting fixture data', async (fault) => {
    const own = await seed();
    await expect(cleanupReviewerCorrectionFixture({ ...own.ctx,
      ...(fault === 'workspace' ? { workspaceId: 'wrong-workspace' } : {}),
      ...(fault === 'harness' ? { harnessSlug: 'wrong-harness' } : {}),
    }, fault === 'nonce' ? 'wrong-nonce' : own.nonce, own.id,
    fault === 'idea' ? 'wrong-idea' : own.ideaId)).rejects.toThrow();
    expect((await row(own.id)).payload).toMatchObject({ reviewerCorrectionFixture: own.nonce });
    expect(await db.adminSql`SELECT idea_id FROM harness_shared.scout_routed_ideas WHERE idea_id=${own.ideaId}`).toHaveLength(1);
    await cleanupReviewerCorrectionFixture(own.ctx, own.nonce, own.id, own.ideaId);
  });
});

describe('BQL D-008 revision adoption through the real claim writer', () => {
  it('control: the intake floor refuses a plain by-id claim of someone else\'s content revision', async () => {
    const { id, harness } = await contentRevision(tag());
    expect(await claimWorkItem(id, ADOPTER, { harness })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('adopts an unheld orphan content revision: claimed by the adopter and rebound to it', async () => {
    const { id, harness } = await contentRevision(tag());
    const deps = adoptDeps();

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, deps as never);

    expect(result).toMatchObject({ adopted: true, brief: { lane: 'revision-adoption', round: 2, previousSubmitter: GONE } });
    const after = await row(id);
    expect(after.taken_by).toBe(ADOPTER);
    expect(after.payload?.agentReview).toMatchObject({ status: 'revision-requested', submittedBy: ADOPTER, round: 2 });
    expect(after.payload?.agentReviewAdoption).toMatchObject({ from: GONE, sessionState: 'ended', adoptedBy: ADOPTER });
    expect(deps.resolveSubmitterLiveness).toHaveBeenCalledWith(GONE, { claimsHeld: false });
  });

  it.each([
    ['issue', true], ['issue', 'true'], ['feature', true], ['feature', 'true'],
  ] as const)('preserves a %s park added after adoption admission was minted; hold=%s', async (family, hold) => {
    const seed = await contentRevision(tag());
    let id = seed.id;
    if (family === 'feature') {
      id = `F-adoption-park-${tag()}`;
      const payload = (await row(seed.id)).payload;
      await db.adminSql`INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, created_ts, updated_ts)
        VALUES (${seed.workspace}, ${seed.harness}, ${id}, 'Content revision', 'Park race fixture',
          'feature', 'open', ${JSON.stringify(payload)}::text::jsonb, 0, 0)`;
    }
    const admission = await mintFor(id, ADOPTER);
    expect(admission).not.toBeNull();
    // The UPDATE must re-check a park added after this capability was minted.
    await mergeWorkItemPayload(id, { _claimHold: hold, claim_hold_by: OTHER }, { harness: seed.harness });
    expect(await claimWorkItem(id, ADOPTER, {
      harness: seed.harness, revisionAdoptionAdmission: admission!,
    })).toBeNull();
    const parked = await row(id);
    expect(parked.taken_by).toBeNull();
    expect(parked.payload).toMatchObject({ _claimHold: hold, claim_hold_by: OTHER });
    expect(parked.payload?.agentReview).toMatchObject({ submittedBy: GONE, round: 2 });

    // Calibration: the same admission succeeds once the park is explicitly lifted.
    await db.adminSql`UPDATE harness_shared.work_items SET payload=payload - '_claimHold' - 'claim_hold_by'
      WHERE workspace_id=${seed.workspace} AND feature_id=${id}`;
    expect(await claimWorkItem(id, ADOPTER, {
      harness: seed.harness, revisionAdoptionAdmission: admission!,
    })).toMatchObject({ id, assignee: ADOPTER });
  });

  it('adopts a revision still held by its gone submitter through the expected-holder CAS', async () => {
    const { id, harness } = await contentRevision(tag(), GONE);

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, adoptDeps() as never);

    expect(result).toMatchObject({ adopted: true });
    const after = await row(id);
    expect(after.taken_by).toBe(ADOPTER);
    expect(after.payload?.agentReview).toMatchObject({ submittedBy: ADOPTER });
  });

  it('refuses a live submitter\'s revision without claiming or rebinding it', async () => {
    const { id, harness } = await contentRevision(tag());
    await patchReview(id, { submittedBy: OTHER, status: 'revision-requested', ledgerIdeaId: 'idea-live', round: 2, revisionKind: 'content' });

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, adoptDeps() as never);

    expect(result).toMatchObject({ adopted: false, reason: 'not-submitter' });
    const after = await row(id);
    expect(after.taken_by).toBeNull();
    expect(after.payload?.agentReview).toMatchObject({ submittedBy: OTHER });
  });

  it('refuses a forged plain-object admission', async () => {
    const { id, harness } = await contentRevision(tag());
    const forged = { itemId: id, adopter: ADOPTER, harnessSlug: harness, previousSubmitter: GONE, round: 2 };

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: forged as never })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('refuses an admission minted for a different adopter', async () => {
    const { id, harness } = await contentRevision(tag());
    const admission = await mintFor(id, OTHER);
    expect(admission).not.toBeNull();

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: admission! })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('refuses a stale admission once the revision round moves (writer re-derivation)', async () => {
    const { id, harness } = await contentRevision(tag());
    const admission = await mintFor(id, ADOPTER);
    expect(admission).not.toBeNull();
    await patchReview(id, { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-moved', round: 3, revisionKind: 'content' });

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: admission! })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('the SQL twin alone refuses a stale admission the writer did not re-check', async () => {
    // claimIssue validates only the admission's identity fields; the revision snapshot is
    // re-checked inside the UPDATE. Bypass claimWorkItem's re-derivation to prove that leg.
    const { id, workspace } = await contentRevision(tag());
    const admission = await mintFor(id, ADOPTER);
    expect(admission).not.toBeNull();
    await patchReview(id, { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-moved', round: 3, revisionKind: 'content' });

    try {
      await claimIssue(id, ADOPTER, { workspaceId: workspace, revisionAdoptionAdmission: admission! });
    } catch {
      /* refused */
    }
    expect((await row(id)).taken_by).toBeNull();

    // Calibration: the same direct call with a CURRENT admission is admitted, so the refusal
    // above is the snapshot check and not some other floor.
    const fresh = await mintFor(id, ADOPTER);
    await claimIssue(id, ADOPTER, { workspaceId: workspace, revisionAdoptionAdmission: fresh! });
    expect((await row(id)).taken_by).toBe(ADOPTER);
  });

  it('does not admit a reproduction-only revision through the adoption leg', async () => {
    const { id } = await contentRevision(tag());
    const r = await row(id);
    const review = readAgentReviewState({
      agentReview: { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-repro', round: 2, revisionKind: 'reproduction' },
    });
    expect(review).not.toBeNull();
    expect(mintAgentReviewRevisionAdoptionAdmission({ itemId: id, adopter: ADOPTER, harnessSlug: r.harness_slug, review: review! })).toBeNull();
  });
});
