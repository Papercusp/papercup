/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): grade-the-grader.
 * A TERMINAL standard-rubric card is stamped audit-pending; a NON-AUTHOR audit
 * against the grading-integrity meta-rubric settles it. The self-audit refusal and
 * the flag-off case are the falsifiability controls — an implementation that stamps
 * unconditionally, or settles on a self-audit, fails one of them in each direction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const getIssue = vi.fn();
const recordGradingAudit = vi.fn();
const markGradingAuditAwaitingReemit = vi.fn();
const isCurrentSourceAuditResponder = vi.fn();
const closeSourceAuditConsults = vi.hoisted(() => vi.fn());
vi.mock('../../grading-audit-routing', () => ({ closeSourceAuditConsults }));
const gateEnabled = vi.fn();
const dispatchPendingGradingAudits = vi.fn();
const readRunningGeneration = vi.fn();
const replaySpecTestAdequacyForHistoricalAudit = vi.fn();

vi.mock('../plans/evaluate-spec-test-adequacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans/evaluate-spec-test-adequacy')>();
  return {
    ...actual,
    replaySpecTestAdequacyForHistoricalAudit: (...args: unknown[]) => replaySpecTestAdequacyForHistoricalAudit(...args),
  };
});

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    // EI-21828643965337454 put the acceptance path behind a FAIL-CLOSED revision
    // read. Unstubbed, it reached the real PG-backed read, returned `ok:false`, and
    // the acceptance-kind case below refused with `..._revision_unreadable` — which
    // looked like the audit-stamp exclusion breaking, when nothing about stamping
    // had changed. Stub it readable; the unreadable leg is covered in
    // emit.vetting.test.ts, which is where that guard's behaviour belongs.
    readRubricPlanRevision: async () => ({ ok: true, revision: 1 }),
    // EI-22177729599840121: the (fail-open) sibling read the new vet-before-grade
    // check uses via acceptance-rubric-vetting.ts's default deps — previously
    // unreached from this file, now exercised by the single acceptance-kind test
    // below. Stub it readable (revision 1, matching readRubricPlanRevision above)
    // rather than leaving it to fall through to the real PG-backed implementation.
    getRubricPlanRevision: async () => 1,
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...real,
    listScorecards: (...a: unknown[]) => listScorecards(...a),
    recordGradingAudit: (...a: unknown[]) => recordGradingAudit(...a),
    markGradingAuditAwaitingReemit: (...a: unknown[]) => markGradingAuditAwaitingReemit(...a),
    isCurrentSourceAuditResponder: (...a: unknown[]) => isCurrentSourceAuditResponder(...a),
  };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
// Keep scorecard writes inside the unit tier: these push notifications are
// database-backed in production and are covered by their own integration tests.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: (...args: unknown[]) => readRunningGeneration(...args),
}));
// Collaborator mock, matching emit-evaluate.test.ts. emit.ts's acceptance branch
// calls these identity helpers, which fall back to a REAL org-admin pool when no
// sql seam is injected — a unit tier must not open a live connection. This file
// predated the callerInImplementerLineage guard added to emit.ts on 2026-08-30.
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  // grader-eligibility resolves the plan's principal implementers before the
  // author/lineage rails; these cards have no subject plan, so the seat is empty.
  resolvePlanImplementerIdentities: vi.fn(async () => []),
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: (...a: unknown[]) => getIssue(...a) };
});
vi.mock('../../grading-integrity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../grading-integrity')>();
  return {
    ...real,
    dispatchPendingGradingAudits: (...a: unknown[]) => dispatchPendingGradingAudits(...a),
    gradingAuditGateEnabled: (...a: unknown[]) => gateEnabled(...a),
  };
});

import { emitScorecard } from './emit';
import { SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';
import { auditVerdictFromRatings } from '../../scorecards';
import { needsGradingAudit } from '../../grading-integrity';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const mkRubric = (rubricId: string, kind: string) => ({
  rubricId,
  revision: 1,
  criteriaHash: 'rubric-hash-v1',
  workspaceId: 'ws',
  kind,
  characteristic: 'grading-integrity',
  title: rubricId,
  description: '',
  criteria: [{ key: 'c1', title: 'C1', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-rubric-author',
  proposedBy: 'su-rubric-author',
  ratifiedBy: 'su-ratifier',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

const RATINGS: ObservationRatings = { c1: { rating: 'pass', evidence: 're-ran the probe, held' } };
const FAIL_RATINGS: ObservationRatings = { c1: { rating: 'fail', evidence: 'probe not re-runnable' } };
const RE_RUN_FAIL_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'fail', evidence: 'probe not re-runnable' },
};
const RE_RUN_PASS_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'pass', evidence: 'probe replayed on the available evaluator' },
};
const RE_RUN_UNKNOWN_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'unknown', evidence: 'available evaluator returned unknown' },
};
const REPLAY_SPLIT_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'pass', evidence: 'exact target recipe executed' },
  'degenerate-distribution': { rating: 'fail', evidence: 'spot replay contradicted the uniform target card' },
};

const RERUN_RECIPE = {
  schemaVersion: 1 as const,
  evaluator: 'plans:evaluate-spec-test-adequacy' as const,
  evaluatorBuild: { sha: 'graded-evaluator-sha', version: '1.2.2' },
  evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
  classRef: 'plan-class-feature-ship' as const,
  args: {
    slug: 'reconnect-plan',
    classRef: 'plan-class-feature-ship' as const,
    specIds: ['SPEC-003-01'],
    includeDraft: true as const,
  },
  selection: {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidence: [{ evidenceKind: 'test', evidenceRef: 'surface:reconnect' }],
  },
  current: {
    supplied: true,
    fingerprints: [
      {
        evidenceKind: 'test',
        evidenceRef: 'surface:reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: 'sha256:fixture',
        rubricFingerprint: 'sha256:rubric',
        environmentFingerprint: 'node:24',
      },
    ],
  },
  derivation: {
    kind: 'listSpecEvidence.currentness' as const,
    classifier: 'classifySpecEvidenceCurrentness' as const,
    unknownWhenMissing: true as const,
  },
};

const GRADED_CARD = {
  id: 'EI-CARD',
  createdAt: '2026-10-02T00:14:36.135Z',
  createdBy: 'su-grader-author',
  payload: {
    observation: {
      rubricRef: 'goal-mode-e2e',
      ratings: { c1: { rating: 'pass', evidence: 'e' } },
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-17T12:00:00.000Z',
      },
    },
  },
};

const replayableGradedCard = (deployedSha: string) => ({
  ...GRADED_CARD,
  payload: {
    observation: {
      ...GRADED_CARD.payload.observation,
      rerunRecipe: RERUN_RECIPE,
      gradedGeneration: {
        deployedSha,
        hostStartedAt: '2026-09-08T18:00:00.000Z',
      },
    },
  },
});

const runningGeneration = (deployedSha: string) => ({
  deployedSha,
  hostStartedAt: '2026-09-08T19:00:00.000Z',
  bootHeadSha: null,
  scoutCodeHash: null,
  staleHost: false,
});

const replayAuditRubric = () => ({
  ...mkRubric('grading-integrity', 'standard'),
  criteria: [
    { key: 're-runnable-evidence', title: 'Re-runnable evidence', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
});

const replayConsistencyAuditRubric = () => ({
  ...mkRubric('grading-integrity', 'standard'),
  criteria: [
    { key: 're-runnable-evidence', title: 'Re-runnable evidence', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'degenerate-distribution', title: 'Degenerate distribution', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
});

const replayConsistencyGradedCard = () => ({
  ...replayableGradedCard('a'.repeat(40)),
  payload: {
    observation: {
      ...replayableGradedCard('a'.repeat(40)).payload.observation,
      rubricRef: 'spec-test-adequacy',
      ratings: { traceability: { rating: 'pass', evidence: 'exact binding replay passed' } },
    },
  },
});

const legacyReplayConsistencyGradedCard = () => ({
  ...replayConsistencyGradedCard(),
  payload: {
    observation: {
      ...replayConsistencyGradedCard().payload.observation,
      rerunRecipe: {
        ...RERUN_RECIPE,
        args: {
          ...RERUN_RECIPE.args,
          evidenceRefs: ['surface:reconnect'],
          specRevision: 1,
          specFingerprint: 'sha256:spec-v1',
          replaySnapshot: true,
          current: RERUN_RECIPE.current.fingerprints,
        },
        selection: {
          ...RERUN_RECIPE.selection,
          evidence: [{ evidenceKind: 'test', evidenceRef: 'surface:reconnect' }],
        },
      },
    },
  },
});

const targetReplay = (
  rating: 'pass' | 'fail',
  evaluatorBuild = RERUN_RECIPE.evaluatorBuild,
) => ({
  ok: true,
  evaluatorBuild,
  rows: [
    {
      specId: 'SPEC-003-01',
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      verdict: rating,
      wouldBlock: rating === 'fail' ? ['traceability'] : [],
      ratings: { traceability: { rating } },
    },
  ],
});

beforeEach(() => {
  closeSourceAuditConsults.mockReset().mockResolvedValue(undefined);
  getRubric.mockReset().mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-AUDIT-1' } });
  getIssue.mockReset().mockResolvedValue(null);
  recordGradingAudit.mockReset().mockResolvedValue({
    ok: true,
    issueId: 'EI-CARD',
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
  });
  markGradingAuditAwaitingReemit.mockReset().mockResolvedValue(true);
  isCurrentSourceAuditResponder.mockReset().mockResolvedValue(true);
  gateEnabled.mockReset().mockResolvedValue(true);
  dispatchPendingGradingAudits.mockReset().mockResolvedValue({ requestedTargetIds: [], receipts: [] });
  readRunningGeneration.mockReset().mockResolvedValue(null);
  replaySpecTestAdequacyForHistoricalAudit.mockReset();
});

describe('scorecards:emit audit-pending stamp (P-013)', () => {
  it('triggers bounded pending-audit dispatch after a newly filed non-audit scorecard', async () => {
    const launchContext = { workspaceId: 'ws-test', harnessSlug: 'papercusp' };
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp', launchContext: launchContext as never },
    );

    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(dispatchPendingGradingAudits).toHaveBeenCalledOnce());
    expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
      targetIds: [],
      ctx: launchContext,
      harness: 'papercusp',
    });
  });

  it('a terminal standard-rubric card is stamped pending and says so in the result', async () => {
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBe(true);
    // EI-22068670622018218: the boolean alone told callers THAT the card was pending but
    // not what settles it, so the mechanism got rediscovered a gate-refusal later. The
    // stamp must ship the next step with it: a NON-AUTHOR grading-integrity audit naming
    // THIS card, plus the two traps (self-audit refused, re-emit files a duplicate).
    const nextStep = (res as { gradingAuditNextStep?: string }).gradingAuditNextStep ?? '';
    expect(nextStep).toContain('NON-AUTHOR');
    expect(nextStep).toContain('existing router automatically selects');
    expect(nextStep).toContain('grading-integrity');
    expect(nextStep).toContain("subject:{ kind:'scorecard'");
    expect(nextStep).toMatch(/self-audits are refused/i);
    expect(nextStep).toMatch(/duplicate pending card/i);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: { state: string; metaRubricRef: string } } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toMatchObject({
      state: 'pending',
      metaRubricRef: 'grading-integrity',
    });
  });

  it('control (kill-switch): flag OFF stamps nothing', async () => {
    gateEnabled.mockResolvedValue(false);
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBeUndefined();
    // The next step is bound to the stamp that creates it: no stamp, no instruction to
    // audit a card nothing is waiting on.
    expect((res as { gradingAuditNextStep?: string }).gradingAuditNextStep).toBeUndefined();
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('an acceptance-kind card is NOT stamped (it has its own grader ≠ author gate)', async () => {
    getRubric.mockResolvedValue(mkRubric('plan-x-acceptance', 'acceptance'));
    // EI-22177729599840121: this is the first acceptance-kind case in this file to
    // reach emitScorecard's vet-before-grade check (createdBy 'su-grader' ≠ the
    // rubric's 'su-rubric-author') — satisfy it with a current attestation so this
    // test stays about audit-stamp exclusion, not vetting.
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'plan-x-acceptance' },
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 1,
          criteriaHash: 'rubric-hash-v1',
          critiquePosts: 1,
          critics: ['su-critic'],
        },
      },
    ]);
    const res = await emitScorecard(
      { rubricRef: 'plan-x-acceptance', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
      // This case exercises audit-stamp exclusion, not the PG-backed coord
      // identity lineage. Keep the unit test on the existing identity seam.
      { sameAcceptanceAuthor: async () => false },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBeUndefined();
  });
});

describe('scorecards:emit grading audit path (P-013)', () => {
  const auditArgs = {
    rubricRef: 'grading-integrity',
    ratings: RATINGS,
    terminal: true,
    subject: { kind: 'scorecard' as const, ref: 'EI-CARD' },
  };
  const activeReservation = {
    key: 'grading-audit:EI-CARD',
    reservedAt: '2026-09-23T18:00:00.000Z',
  };
  const gradedCardWithReservation = () => ({
    ...GRADED_CARD,
    payload: {
      observation: {
        ...GRADED_CARD.payload.observation,
        gradingAudit: {
          ...GRADED_CARD.payload.observation.gradingAudit,
          dispatchReservation: activeReservation,
        },
      },
    },
  });
  beforeEach(() => {
    getRubric.mockResolvedValue(mkRubric('grading-integrity', 'standard'));
    getIssue.mockResolvedValue(GRADED_CARD);
  });

  it('identifies an omitted active dispatch lease before filing a card', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(auditArgs, { createdBy: 'su-second-auditor', ctxHarness: 'papercusp' });

    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('grading_audit_reservation_missing');
    expect((res as { error?: string }).error).toContain('gradingAuditReservation is missing');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('identifies a mismatched active dispatch lease before filing a card', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(
      {
        ...auditArgs,
        gradingAuditReservation: { ...activeReservation, reservedAt: '2026-09-23T18:00:01.000Z' },
      },
      { createdBy: 'su-stale-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('grading_audit_reservation_mismatch');
    expect((res as { error?: string }).error).toContain('does not match its current active dispatch reservation');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('settles only when the emitter presents the exact active dispatch lease', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-dispatched-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(true);
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({ dispatchReservation: activeReservation }),
    );
  });

  it('refuses a prior cascade answerer before filing when the consult moved to another auditor', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());
    isCurrentSourceAuditResponder.mockResolvedValue(false);

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-stale-answerer', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('different active consult answerer');
    expect(isCurrentSourceAuditResponder).toHaveBeenCalledWith('EI-CARD', activeReservation, 'su-stale-answerer');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('a NON-AUTHOR audit files, settles the subject, and is itself never stamped pending (one level)', async () => {
    const res = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(res.ok).toBe(true);
    expect(closeSourceAuditConsults).toHaveBeenCalledWith(expect.any(String), 'EI-CARD');
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({
        auditIssueId: 'EI-AUDIT-1',
        auditor: 'su-auditor',
        verdict: 'passed',
        rubricRevision: 1,
        criteriaHash: 'rubric-hash-v1',
        requireCurrentIdentity: true,
      }),
    );
    expect((res as { gradingAuditRecorded?: boolean }).gradingAuditRecorded).toBe(true);
    // D-004 one level: the audit card carries NO pending stamp of its own.
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('a failing rating settles the subject as failed', async () => {
    await emitScorecard({ ...auditArgs, ratings: FAIL_RATINGS }, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it('refuses unknown audit ratings before filing an orphan audit card', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    const res = await emitScorecard(
      {
        ...auditArgs,
        ratings: {
          're-runnable-evidence': { rating: 'unknown', evidence: 'the evaluator build could not verify this' },
          'degenerate-distribution': { rating: 'unknown', evidence: 'the evaluator build could not verify this' },
        },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_verdict_unknown' });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
    expect(closeSourceAuditConsults).not.toHaveBeenCalled();
  });

  it('refuses a same-rubric non-author emit for a pending subject audit and teaches the grading-integrity shape', async () => {
    getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
    getIssue.mockResolvedValue(null);
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-PENDING-SUBJECT',
        createdAt: '2026-08-27T14:00:00.000Z',
        createdBy: 'su-subject-author',
        subject: { kind: 'plan', ref: 'plan-x' },
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-27T14:00:00.000Z',
        },
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const res = await emitScorecard(
      {
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        terminal: true,
        subject: { kind: 'plan', ref: 'plan-x' },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('grading-integrity');
    expect((res as { error?: string }).error).toContain("supersedes:'EI-PENDING-SUBJECT'");
    expect((res as { error?: string }).error).toContain("subject:{ kind:'scorecard'");
    expect((res as { error?: string }).error).toContain('EI-PENDING-SUBJECT');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses a same-author re-emit while the subject still has a live pending audit', async () => {
    getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
    getIssue.mockResolvedValue(null);
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-PENDING-SAME-AUTHOR',
        createdAt: '2026-08-27T14:00:00.000Z',
        createdBy: 'su-subject-author',
        subject: { kind: 'plan', ref: 'plan-x' },
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-27T14:00:00.000Z',
        },
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const res = await emitScorecard(
      {
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        terminal: true,
        force: true,
        subject: { kind: 'plan', ref: 'plan-x' },
      },
      { createdBy: 'su-subject-author', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
    expect((res as { error?: string }).error).toContain('EI-PENDING-SAME-AUTHOR');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  describe('a RE-OPENED audit (WI-10005211)', () => {
    // A grading-integrity revision re-opens every settled audit, so a windowed
    // grader's earlier cards all read pending again at once. The card already
    // carries an independent verdict; it must not block its own author's next card.
    const reopenedCard = {
      issueId: 'EI-REOPENED',
      createdAt: '2026-10-01T12:38:00.000Z',
      createdBy: 'su-subject-author',
      subject: { kind: 'plan', ref: 'plan-x' },
      rubricRef: 'goal-mode-e2e',
      ratings: RATINGS,
      nKeys: 1,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        rubricRevision: 10,
        stampedAt: '2026-10-02T01:38:32.000Z',
      },
      synthesized: false,
      score10: 10,
      linkedItems: [],
    };
    const priorAudit = (retracted?: object) => ({
      issueId: 'EI-PRIOR-AUDIT',
      createdAt: '2026-10-01T14:19:00.000Z',
      createdBy: 'su-auditor',
      subject: { kind: 'scorecard', ref: 'EI-REOPENED' },
      rubricRef: 'grading-integrity',
      ratings: RATINGS,
      nKeys: 1,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
      score10: 10,
      linkedItems: [],
      ...(retracted ? { retracted } : {}),
    });
    const withAudits = (audits: object[]) =>
      listScorecards.mockImplementation(async (filter: { rubricRef?: string }) =>
        filter.rubricRef === 'grading-integrity' ? audits : [reopenedCard],
      );
    const emitNext = (createdBy: string) =>
      emitScorecard(
        {
          rubricRef: 'goal-mode-e2e',
          ratings: RATINGS,
          terminal: true,
          force: true,
          subject: { kind: 'plan', ref: 'plan-x' },
        },
        { createdBy, ctxHarness: 'papercusp' },
      );

    beforeEach(() => {
      getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
      getIssue.mockResolvedValue(null);
    });

    it("files the author's next same-subject card instead of refusing on its own re-opened card", async () => {
      withAudits([priorAudit()]);

      const res = await emitNext('su-subject-author');

      expect(res.ok).toBe(true);
      expect(captureImprovement).toHaveBeenCalledOnce();
      expect(listScorecards).toHaveBeenCalledWith(
        expect.objectContaining({ rubricRef: 'grading-integrity', subjectRefs: ['EI-REOPENED'] }),
      );
    });

    it('control: a RETRACTED prior audit is not a verdict, so the card still blocks', async () => {
      withAudits([priorAudit({ reason: 'withdrawn', at: '2026-10-01T15:00:00.000Z' })]);

      const res = await emitNext('su-subject-author');

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
      expect((res as { error?: string }).error).toContain('EI-REOPENED');
      expect(captureImprovement).not.toHaveBeenCalled();
    });

    it('control: a NON-AUTHOR is still taught the audit shape on a re-opened card', async () => {
      withAudits([priorAudit()]);

      const res = await emitNext('su-other-grader');

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
      expect((res as { error?: string }).error).toContain("subject:{ kind:'scorecard', ref:'EI-REOPENED' }");
      expect(captureImprovement).not.toHaveBeenCalled();
    });
  });

  it('control (THE mirror rule): a SELF-audit is refused and nothing is filed or settled', async () => {
    const res = await emitScorecard(auditArgs, {
      createdBy: 'su-grader-author', // the graded card's own author
      ctxHarness: 'papercusp',
    });
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('self_audit_refused');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses an auditor in the graded card author lineage, not only the exact author', async () => {
    const lineageRelated = vi.fn(async (
      first: string | null | undefined,
      second: string | null | undefined,
      _opts?: import('../../acceptance-author-identity').AcceptanceAuthorIdentityOpts,
    ) => {
      return first === 'su-grader-author' && second === 'su-grader-descendant';
    });
    const res = await emitScorecard(
      auditArgs,
      {
        createdBy: 'su-grader-descendant',
        ctxHarness: 'papercusp',
        workspaceId: 'ws-test',
      },
      { lineageRelated },
    );
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining("auditor 'su-grader-descendant' is in the graded card author's identity lineage ('su-grader-author')"),
    });
    expect(lineageRelated).toHaveBeenCalledWith('su-grader-author', 'su-grader-descendant', {
      workspaceId: 'ws-test',
    });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses an auditor who is the graded card evidence source even when they are not its author', async () => {
    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          // The critic identity is the evidence source for this vetting card;
          // its author is deliberately different to prove the old author-only
          // guard would have allowed the audit.
          vetting: {
            consultId: 'conv-vetting',
            rubricRevision: 1,
            critiquePosts: 1,
            critics: ['su-evidence-source'],
          },
        },
      },
    });

    const res = await emitScorecard(auditArgs, {
      createdBy: 'su-evidence-source',
      ctxHarness: 'papercusp',
      workspaceId: 'ws-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'auditor_is_graded_card_evidence_source' });
    expect((res as { error?: string }).error).toContain('recorded evidence source');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses a degenerate-distribution failure when the exact server replay reproduces every target rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('pass'));

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect((res as { error?: string }).error).toContain('reproduced every applicable rating');
    expect(dispatchTool).toHaveBeenCalledWith(
      'plans:evaluate-spec-test-adequacy',
      expect.objectContaining({
        slug: 'reconnect-plan',
        detail: 'summary',
        includeDraft: true,
        payloadTier: 'full',
      }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('allows the same audit split when the exact server replay really contradicts a target rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    readRunningGeneration.mockResolvedValue(runningGeneration('a'.repeat(40)));
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('fail'));

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledOnce();
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it('falls back to a marked historical replay only when a legacy current read is selection_empty', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(legacyReplayConsistencyGradedCard());
    const dispatchTool = vi.fn().mockResolvedValue({ ok: false, error: 'selection_empty', count: 0 });
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue({
      ok: true,
      evaluatorBuild: RERUN_RECIPE.evaluatorBuild,
      rows: targetReplay('pass').rows,
      historicalAuditOnly: {
        provenance: 'historical-audit-only',
        asOf: GRADED_CARD.createdAt,
        freshness: 'audit-only',
        bindings: [
          {
            id: 19999,
            evidenceKind: 'test',
            evidenceRef: 'surface:reconnect',
            withdrawal: { at: '2026-10-02T01:00:00.000Z', reason: 'superseded by binding 21019' },
          },
        ],
      },
    });

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(dispatchTool).toHaveBeenCalledWith(
      'plans:evaluate-spec-test-adequacy',
      expect.objectContaining({
        evidenceRefs: ['surface:reconnect'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
      }),
    );
    expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.any(String),
        auditAsOf: new Date(GRADED_CARD.createdAt),
        selection: expect.objectContaining({ specId: 'SPEC-003-01', specRevision: 1 }),
      }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy historical replay has no graded-card creation time', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue({ ...legacyReplayConsistencyGradedCard(), createdAt: undefined });
    const dispatchTool = vi.fn().mockResolvedValue({ ok: false, error: 'selection_empty', count: 0 });

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_uncorroborated' });
    expect((res as { error?: string }).error).toContain('graded card creation time or workspace scope is unavailable');
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(replaySpecTestAdequacyForHistoricalAudit).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('defers the grading audit when the exact evaluator replay reports build drift', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const liveEvaluatorBuild = { sha: 'current-evaluator-sha', version: '1.2.3' };
    const dispatchTool = vi.fn().mockResolvedValue({
      ...targetReplay('fail', liveEvaluatorBuild),
      evaluatorBuildDrift: { recorded: RERUN_RECIPE.evaluatorBuild, live: liveEvaluatorBuild },
    });

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain('evaluator-build-drift');
    expect(dispatchTool).toHaveBeenCalledWith(
      'plans:evaluate-spec-test-adequacy',
      expect.objectContaining({
        slug: 'reconnect-plan',
        evaluatorBuild: RERUN_RECIPE.evaluatorBuild,
        detail: 'summary',
        includeDraft: true,
        payloadTier: 'full',
      }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('fails closed when replay build identity differs without a drift marker', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const liveEvaluatorBuild = { sha: 'current-evaluator-sha', version: '1.2.3' };
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('fail', liveEvaluatorBuild));

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain('changed build identity');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('requires re-emitting a legacy card when a newer evaluator revision changes its rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    const currentCard = replayConsistencyGradedCard();
    const reservation = {
      key: 'grading-audit:EI-CARD',
      reservedAt: '2026-09-24T11:38:02.124Z',
    };
    const { evaluatorRevision: _currentRevision, ...legacyRecipe } = RERUN_RECIPE;
    getIssue.mockResolvedValue({
      ...currentCard,
      payload: {
        observation: {
          ...currentCard.payload.observation,
          gradingAudit: {
            ...currentCard.payload.observation.gradingAudit,
            dispatchReservation: reservation,
          },
          rerunRecipe: legacyRecipe,
          ratings: {
            falsifiability: { rating: 'pass', evidence: 'recorded under the earlier targeting rule' },
            traceability: { rating: 'pass', evidence: 'exact binding replay passed' },
          },
        },
      },
    });
    const exactReplay = targetReplay('pass');
    const dispatchTool = vi.fn().mockResolvedValue({
      ...exactReplay,
      rows: [
        {
          ...exactReplay.rows[0],
          wouldBlock: ['falsifiability'],
          ratings: {
            falsifiability: { rating: 'unknown' },
            traceability: { rating: 'pass' },
          },
        },
      ],
    });

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: reservation, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain(`changed from 1 to ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`);
    expect((res as { error?: string }).error).toContain('re-emit the target card');
    expect(markGradingAuditAwaitingReemit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({ state: 'pending', dispatchReservation: reservation }),
      expect.objectContaining({ reason: expect.stringContaining(`changed from 1 to ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`) }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['older', false, 'auditor-build-older-than-graded-build'],
    ['unknown', null, 'generation-ancestry-unknown'],
  ] as const)(
    'fails closed when the auditor generation is %s than the replayable graded card',
    async (_label, probeResult, reason) => {
      const gradedSha = 'a'.repeat(40);
      const auditorSha = 'b'.repeat(40);
      getRubric.mockResolvedValue(replayAuditRubric());
      getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
      readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
      const generationAncestry = vi.fn().mockReturnValue(probeResult);

      const res = await emitScorecard(
        { ...auditArgs, ratings: RE_RUN_FAIL_RATINGS },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
        { generationAncestry },
      );

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_generation_incompatible' });
      expect((res as { error?: string }).error).toContain(reason);
      expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
      expect(readRunningGeneration).toHaveBeenCalledOnce();
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['pass', RE_RUN_PASS_RATINGS],
    ['unknown', RE_RUN_UNKNOWN_RATINGS],
  ] as const)(
    'fails closed when a stale auditor records re-runnable-evidence=%s',
    async (_rating, ratings) => {
      const gradedSha = 'a'.repeat(40);
      const auditorSha = 'b'.repeat(40);
      getRubric.mockResolvedValue(replayAuditRubric());
      getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
      readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
      const generationAncestry = vi.fn().mockReturnValue(false);

      const res = await emitScorecard(
        { ...auditArgs, ratings },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
        { generationAncestry },
      );

      if (_rating === 'unknown') {
        expect(res).toMatchObject({ ok: false, code: 'grading_audit_verdict_unknown' });
        expect(generationAncestry).not.toHaveBeenCalled();
      } else {
        expect(res).toMatchObject({ ok: false, code: 'grading_audit_generation_incompatible' });
        expect((res as { error?: string }).error).toContain('auditor-build-older-than-graded-build');
        expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
      }
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it('allows a descendant auditor generation to settle a failing replayable card', async () => {
    const gradedSha = 'a'.repeat(40);
    const auditorSha = 'b'.repeat(40);
    getRubric.mockResolvedValue(replayAuditRubric());
    getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
    readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
    const generationAncestry = vi.fn().mockReturnValue(true);

    const res = await emitScorecard(
      { ...auditArgs, ratings: RE_RUN_FAIL_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
      { generationAncestry },
    );

    expect(res.ok).toBe(true);
    expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
    expect(readRunningGeneration).toHaveBeenCalledOnce();
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it('refuses without a scorecard subject, on a non-scorecard subject, and on an already-audited one', async () => {
    const noSubject = await emitScorecard(
      { rubricRef: 'grading-integrity', ratings: RATINGS, terminal: true },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );
    expect(noSubject.ok).toBe(false);
    expect((noSubject as { error?: string }).error).toContain("kind:'scorecard'");

    getIssue.mockResolvedValue(null);
    const notCard = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(notCard.ok).toBe(false);
    expect((notCard as { error?: string }).error).toContain('not a scorecard');

    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          retracted: { at: '2026-08-17T12:00:00.000Z', by: 'su-author', reason: 'withdrawn' },
          gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
        },
      },
    });
    const withdrawn = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(withdrawn.ok).toBe(false);
    expect((withdrawn as { error?: string }).error).toContain('is retracted and cannot be audited');
    expect(recordGradingAudit).not.toHaveBeenCalled();

    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
        },
      },
    });
    const already = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(already.ok).toBe(false);
    expect((already as { error?: string }).error).toContain('already audited');
  });

  it('allows a correction to supersede the existing audit card after the subject is settled', async () => {
    const settledGradedCard = {
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          gradingAudit: {
            state: 'passed',
            metaRubricRef: 'grading-integrity',
            auditIssueId: 'EI-AUDIT-OLD',
            auditor: 'su-old-auditor',
            stampedAt: '2026-08-17T12:00:00.000Z',
          },
        },
      },
    };
    const priorAudit = {
      id: 'EI-AUDIT-OLD',
      createdBy: 'su-old-auditor',
      payload: {
        observation: {
          rubricRef: 'grading-integrity',
          ratings: RATINGS,
          subject: { kind: 'scorecard', ref: 'EI-CARD' },
        },
      },
    };
    // The settled-subject exception and the generic supersedes validator both
    // read the referenced audit card; keep both reads on the same prior card.
    getIssue
      .mockResolvedValueOnce(settledGradedCard)
      .mockResolvedValueOnce(priorAudit)
      .mockResolvedValueOnce(priorAudit);

    const res = await emitScorecard(
      { ...auditArgs, supersedes: 'EI-AUDIT-OLD' },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: true, created: true, supersedes: 'EI-AUDIT-OLD' });
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({
        auditIssueId: 'EI-AUDIT-1',
        verdict: 'passed',
        supersedesAuditIssueId: 'EI-AUDIT-OLD',
      }),
    );
    expect(captureImprovement.mock.calls[0]?.[0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'grading-integrity',
          supersedes: 'EI-AUDIT-OLD',
          subject: { kind: 'scorecard', ref: 'EI-CARD' },
        },
      },
    });
  });
});

describe('pure halves (P-013)', () => {
  it('auditVerdictFromRatings: failures dominate; unknown/custom/empty ratings cannot pass', () => {
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'exemplary' } })).toBe('passed');
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'severe' } })).toBe('failed');
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'unknown' } })).toBeNull();
    expect(auditVerdictFromRatings({ a: { rating: 'custom-unmapped' } })).toBeNull();
    expect(auditVerdictFromRatings({})).toBeNull();
  });

  it('needsGradingAudit: standard+terminal only, never the meta-rubric itself (one level, no regress)', () => {
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: false })).toBe(true);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: true })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'acceptance', rubricRef: 'plan-x', provisional: false })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'grading-integrity', provisional: false })).toBe(
      false,
    );
  });
});
