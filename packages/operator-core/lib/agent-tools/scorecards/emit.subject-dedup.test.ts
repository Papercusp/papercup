/**
 * The final unchanged-evidence read must be scoped to the scorecard's typed
 * subject. A newer card for another subject can otherwise hide an identical
 * prior card and make the emitter append a duplicate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...actual,
    getRubric: (...args: unknown[]) => getRubric(...args),
    getRubricEvidenceIdentity: (...args: unknown[]) => getRubricEvidenceIdentity(...args),
    getRubricPlanRevision: (...args: unknown[]) => getRubricPlanRevision(...args),
    readRubricPlanRevision: (...args: unknown[]) => readRubricPlanRevision(...args),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: (...args: unknown[]) => listScorecards(...args) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovement(...args),
}));
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, getIssue: async () => null };
});
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import { emitScorecard } from './emit';

const RUBRIC = {
  rubricId: 'subject-dedup-test',
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'subject-dedup',
  title: 'Subject dedup',
  description: '',
  criteria: [{ key: 'c1', title: 'C1', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'unknown', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  revision: 7,
  criteriaHash: 'criteria-v1',
};

const rubricRef = 'subject-dedup-test';
const subjectRef = 'plan-alpha#SPEC-P-001@1';
const ratings = { c1: { rating: 'pass', evidence: 'the same measured evidence' } };

beforeEach(() => {
  vi.clearAllMocks();
  getRubric.mockResolvedValue(RUBRIC);
  getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: 'criteria-v1', meaningRevision: null });
  getRubricPlanRevision.mockResolvedValue(7);
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  captureImprovement.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-new' } });
});

describe('scorecards:emit unchanged-evidence subject scope', () => {
  it('finds the prior same-subject card when a newer other-subject card exists', async () => {
    const args = { rubricRef, ratings, subject: { kind: 'plan' as const, ref: subjectRef } };
    const input = { createdBy: 'su-grader', ctxHarness: 'papercusp' };
    const firstEmit = await emitScorecard(args, input);
    expect(firstEmit).toMatchObject({ ok: true, created: true });
    const storedObservation = (captureImprovement.mock.calls[0]?.[0] as unknown as {
      payloadExtra: { observation: Record<string, unknown> };
    }).payloadExtra.observation;
    expect(storedObservation.evidenceFingerprint).toBe(
      (firstEmit as { evidenceFingerprint?: string }).evidenceFingerprint,
    );
    const sameSubject = {
      ...storedObservation,
      issueId: 'EI-same-subject',
      createdBy: 'su-grader',
      rubricRef,
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
    };
    const newerOtherSubject = {
      ...sameSubject,
      issueId: 'EI-newer-other-subject',
      ratings: { c1: { rating: 'fail', evidence: 'different measured evidence' } },
      evidenceFingerprint: 'different-subject-evidence',
      subject: { kind: 'issue', ref: 'EI-unrelated' },
    };

    listScorecards.mockImplementation(async (filter: {
      limit?: number;
      subjectKind?: string;
      subjectRef?: string;
    }) => {
      if (filter.limit !== 1) return [];
      if (filter.subjectKind === 'plan' && filter.subjectRef === subjectRef) return [sameSubject];
      return [newerOtherSubject];
    });

    const result = await emitScorecard(args, input);

    const finalFilter = listScorecards.mock.calls.at(-1)?.[0];
    expect(finalFilter).toEqual({
      rubricRef,
      sourceHive: 'papercusp',
      subjectRef,
      subjectKind: 'plan',
      limit: 1,
    });
    expect(result, JSON.stringify({ result, storedObservation, finalFilter })).toMatchObject({
      ok: true,
      created: false,
      reason: 'unchanged-evidence',
      previousIssueId: 'EI-same-subject',
    });
    expect(captureImprovement).toHaveBeenCalledOnce();
  });
});
