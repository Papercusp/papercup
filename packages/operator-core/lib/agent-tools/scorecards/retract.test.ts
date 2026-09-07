import { describe, expect, it, vi } from 'vitest';
import { resetGradingAuditStampForRetraction, retractScorecard } from '../../scorecards';

const RATINGS = { criterion: { rating: 'healthy', evidence: 'verified' } };

describe('retractScorecard', () => {
  it('preserves the complete nested observation while attaching withdrawal metadata', async () => {
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'rubric-a',
          ratings: RATINGS,
          sourceHive: 'papercusp',
          evidenceFingerprint: 'fp-1',
          instrumentSnapshots: { probe: { verdict: 'pass' } },
        },
        unrelated: { keep: true },
      },
    }));
    const mergeIssuePayload = vi.fn(async () => ({ id: 'EI-1' }));

    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'wrong repository', at: '2026-08-14T23:00:00.000Z' },
      { getIssue: getIssue as never, mergeIssuePayload: mergeIssuePayload as never },
    );

    expect(result).toEqual({
      ok: true,
      issueId: 'EI-1',
      retracted: true,
      retraction: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'wrong repository' },
    });
    expect(mergeIssuePayload).toHaveBeenCalledWith('EI-1', {
      observation: {
        rubricRef: 'rubric-a',
        ratings: RATINGS,
        sourceHive: 'papercusp',
        evidenceFingerprint: 'fp-1',
        instrumentSnapshots: { probe: { verdict: 'pass' } },
        retracted: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'wrong repository' },
      },
    });
  });

  it('retracts an incomplete historical scorecard with an empty ratings map', async () => {
    const getIssue = vi.fn(async () => ({
      payload: { observation: { rubricRef: 'rubric-a', ratings: {} } },
    }));
    const mergeIssuePayload = vi.fn(async () => ({ id: 'EI-1' }));

    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'incomplete legacy card', at: '2026-08-14T23:00:00.000Z' },
      { getIssue: getIssue as never, mergeIssuePayload: mergeIssuePayload as never },
    );

    expect(result).toEqual({
      ok: true,
      issueId: 'EI-1',
      retracted: true,
      retraction: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'incomplete legacy card' },
    });
    expect(mergeIssuePayload).toHaveBeenCalledWith('EI-1', {
      observation: {
        rubricRef: 'rubric-a',
        ratings: {},
        retracted: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'incomplete legacy card' },
      },
    });
  });

  it('is idempotent and does not rewrite an already retracted scorecard', async () => {
    const prior = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'withdrawn' };
    const getIssue = vi.fn(async () => ({
      payload: { observation: { rubricRef: 'rubric-a', ratings: RATINGS, retracted: prior } },
    }));
    const mergeIssuePayload = vi.fn();
    const result = await retractScorecard(
      'EI-1',
      { by: 'su-2', reason: 'again' },
      { getIssue: getIssue as never, mergeIssuePayload: mergeIssuePayload as never },
    );
    expect(result).toEqual({ ok: true, issueId: 'EI-1', retracted: true, retraction: prior });
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('atomically retracts a grading-integrity audit and repairs its cited subject', async () => {
    const retraction = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'falsified finding' };
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'grading-integrity',
          ratings: RATINGS,
          subject: { kind: 'scorecard', ref: 'EI-SUBJECT' },
        },
      },
    }));
    const retractGradingAudit = vi.fn(async () => ({ retraction, subjectReset: true }));
    const mergeIssuePayload = vi.fn();

    const result = await retractScorecard(
      'EI-AUDIT',
      { by: 'su-1', reason: 'falsified finding', at: retraction.at },
      {
        getIssue: getIssue as never,
        mergeIssuePayload: mergeIssuePayload as never,
        retractGradingAudit: retractGradingAudit as never,
      },
    );

    expect(result).toEqual({ ok: true, issueId: 'EI-AUDIT', retracted: true, retraction });
    expect(retractGradingAudit).toHaveBeenCalledWith('EI-AUDIT', 'EI-SUBJECT', retraction);
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('only clears the settlement metadata for the audit currently cited by the subject', () => {
    const subject = {
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      gradingAudit: {
        state: 'failed',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
        auditIssueId: 'EI-AUDIT',
        auditor: 'su-1',
        auditedAt: '2026-08-14T23:00:00.000Z',
      },
    };

    expect(resetGradingAuditStampForRetraction(subject, 'EI-AUDIT')).toEqual({
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
      },
    });
    expect(
      resetGradingAuditStampForRetraction(
        { ...subject, gradingAudit: { ...subject.gradingAudit, auditIssueId: 'EI-LATER-CORRECTION', state: 'passed' } },
        'EI-AUDIT',
      ),
    ).toBeNull();
  });

  it('refuses a non-scorecard issue without mutating it', async () => {
    const getIssue = vi.fn(async () => ({ payload: { observation: { kind: 'friction' } } }));
    const mergeIssuePayload = vi.fn();
    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'not a scorecard' },
      { getIssue: getIssue as never, mergeIssuePayload: mergeIssuePayload as never },
    );
    expect(result).toMatchObject({ ok: false, retracted: false, error: expect.stringContaining('not a complete scorecard') });
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });
});
