import { describe, expect, it, vi } from 'vitest';
import { retractScorecard } from '../../scorecards';

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
