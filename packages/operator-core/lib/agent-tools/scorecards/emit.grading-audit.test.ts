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
const gateEnabled = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return { ...real, getRubric: (...a: unknown[]) => getRubric(...a) };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...real,
    listScorecards: (...a: unknown[]) => listScorecards(...a),
    recordGradingAudit: (...a: unknown[]) => recordGradingAudit(...a),
  };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: (...a: unknown[]) => getIssue(...a) };
});
vi.mock('../../grading-integrity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../grading-integrity')>();
  return { ...real, gradingAuditGateEnabled: (...a: unknown[]) => gateEnabled(...a) };
});

import { emitScorecard } from './emit';
import { auditVerdictFromRatings } from '../../scorecards';
import { needsGradingAudit } from '../../grading-integrity';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const mkRubric = (rubricId: string, kind: string) => ({
  rubricId,
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

const GRADED_CARD = {
  id: 'EI-CARD',
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

beforeEach(() => {
  getRubric.mockReset().mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-AUDIT-1' } });
  getIssue.mockReset().mockResolvedValue(null);
  recordGradingAudit.mockReset().mockResolvedValue({
    ok: true,
    issueId: 'EI-CARD',
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
  });
  gateEnabled.mockReset().mockResolvedValue(true);
});

describe('scorecards:emit audit-pending stamp (P-013)', () => {
  it('a terminal standard-rubric card is stamped pending and says so in the result', async () => {
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBe(true);
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
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('an acceptance-kind card is NOT stamped (it has its own grader ≠ author gate)', async () => {
    getRubric.mockResolvedValue(mkRubric('plan-x-acceptance', 'acceptance'));
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
  beforeEach(() => {
    getRubric.mockResolvedValue(mkRubric('grading-integrity', 'standard'));
    getIssue.mockResolvedValue(GRADED_CARD);
  });

  it('a NON-AUTHOR audit files, settles the subject, and is itself never stamped pending (one level)', async () => {
    const res = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(res.ok).toBe(true);
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', {
      auditIssueId: 'EI-AUDIT-1',
      auditor: 'su-auditor',
      verdict: 'passed',
    });
    expect((res as { gradingAuditRecorded?: boolean }).gradingAuditRecorded).toBe(true);
    // D-004 one level: the audit card carries NO pending stamp of its own.
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('a failing rating settles the subject as failed', async () => {
    await emitScorecard(
      { ...auditArgs, ratings: FAIL_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
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
          gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
        },
      },
    });
    const already = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(already.ok).toBe(false);
    expect((already as { error?: string }).error).toContain('already audited');
  });
});

describe('pure halves (P-013)', () => {
  it('auditVerdictFromRatings: any fail-vocabulary rating fails; unknown/custom never fail silently', () => {
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'exemplary' } })).toBe('passed');
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'severe' } })).toBe('failed');
    expect(auditVerdictFromRatings({ a: { rating: 'unknown' } })).toBe('passed');
    expect(auditVerdictFromRatings({})).toBe('passed');
  });

  it('needsGradingAudit: standard+terminal only, never the meta-rubric itself (one level, no regress)', () => {
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: false })).toBe(true);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: true })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'acceptance', rubricRef: 'plan-x', provisional: false })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'grading-integrity', provisional: false })).toBe(false);
  });
});
