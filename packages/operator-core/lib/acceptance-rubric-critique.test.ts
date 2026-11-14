import { describe, expect, it } from 'vitest';
import type { Rubric } from './rubrics';
import {
  critiqueCoversRubric,
  readCurrentAcceptanceRubricCritique,
} from './acceptance-rubric-critique';

const rubric = {
  rubricId: 'acceptance-host-memory-right-sizing-2026-10-31',
  criteriaHash: '922497be1655acce69685460cc4e4c12bdfbbf1654231fa1809ea75a05473f4f',
  createdBy: 'su-author',
  proposedBy: 'su-author',
} as Rubric;

// The completed independent reviews named subject plan revision25 and rubric@11.
const request = `Independently critique the COMPLETE current accepted behavior contract for ` +
  `host-memory-right-sizing-2026-10-31 revision25, ${rubric.rubricId}@11: ` +
  'allR1..R8, eightAUTO-BAR projections and thirteenMEM clauses.';

describe('critiqueCoversRubric revision identity', () => {
  it('recognizes the rubric pin independently of the subject plan revision', () => {
    expect(critiqueCoversRubric(request, rubric, 11)).toBe(true);
    expect(critiqueCoversRubric(request, rubric, 25)).toBe(false);
  });

  it.each(['10', '110', '11a', '11.2', '11-old', '11@other', '011', ''])
    ('refuses stale or malformed explicit pin @%s despite another revision11', pin => {
      expect(critiqueCoversRubric(`Plan revision11; ${rubric.rubricId}@${pin}`, rubric, 11)).toBe(false);
    });

  it('refuses conflicting pins and an unknown live revision', () => {
    expect(critiqueCoversRubric(`${request} Also ${rubric.rubricId}@10`, rubric, 11)).toBe(false);
    expect(critiqueCoversRubric(request, rubric, null)).toBe(false);
  });

  it.each(['rev11', 'revision 11', 'revision:11'])('preserves explicit %s references', version => {
    expect(critiqueCoversRubric(`Vet ${rubric.rubricId} ${version}`, rubric, 11)).toBe(true);
  });

  it('requires a bounded rubric identity and an explicit version', () => {
    expect(critiqueCoversRubric(`Vet ${rubric.rubricId}`, rubric, 11)).toBe(false);
    expect(critiqueCoversRubric(`Vet other-${rubric.rubricId}@11`, rubric, 11)).toBe(false);
    expect(critiqueCoversRubric(`Vet ${rubric.rubricId}-other@11`, rubric, 11)).toBe(false);
  });

  it('preserves content-hash precedence and contradictory-hash refusal', () => {
    expect(critiqueCoversRubric(`${request} criteriaHash: stale`, rubric, 11)).toBe(false);
    expect(critiqueCoversRubric(`${request} criteriaHash: ${rubric.criteriaHash}`, rubric, 12)).toBe(true);
  });
});

describe('readCurrentAcceptanceRubricCritique with pinned reviews', () => {
  const candidate = { consultId: 'consult-current', request, createdAt: '2026-11-02T07:27:57.351Z' };

  it('recognizes an existing independent answer without requesting a meta-scorecard', async () => {
    await expect(readCurrentAcceptanceRubricCritique(rubric, 11, {
      candidates: async () => [candidate],
      consult: async () => ({ exists: true, critiquePosts: 1, critics: ['su-independent'] }),
    })).resolves.toMatchObject({
      consultId: candidate.consultId,
      rubricRevision: 11,
      criteriaHash: rubric.criteriaHash,
      critics: ['su-independent'],
    });
  });

  it.each([
    { exists: true, critiquePosts: 1, critics: ['su-author'] },
    { exists: true, critiquePosts: 0, critics: ['su-independent'] },
    { exists: false, critiquePosts: 1, critics: ['su-independent'] },
  ])('keeps independent-answer admission for %j', async answer => {
    await expect(readCurrentAcceptanceRubricCritique(rubric, 11, {
      candidates: async () => [candidate],
      consult: async () => answer,
    })).resolves.toBeNull();
  });
});

describe('work-item critique candidate discovery', () => {
  const gcsRubric = {
    rubricId: 'acceptance-r2-to-gcs-storage-migration-2026-10-23',
    criteriaHash: '637ae03c71dedbe043add79a2dddca77416a9456deb5e80607fb69171f807b1',
    createdBy: 'su-rubric-author',
    proposedBy: 'su-rubric-author',
  } as Rubric;
  const originalReview = {
    id: 'WI-6554700010046043',
    title: 'Independent full-contract critique of GCS acceptance rubric revision4',
    summary: `Review ${gcsRubric.rubricId} criteriaHash: ${gcsRubric.criteriaHash}; reviewer ebe9`,
    updatedAt: '2026-11-06T20:00:36.784Z',
  };
  const readWorkItemReview = (
    review: typeof originalReview,
    answer: { exists: boolean; critiquePosts: number; critics: string[] },
  ) => readCurrentAcceptanceRubricCritique(gcsRubric, 4, {
    consultCandidates: async () => [],
    searchReviewWorkItems: async () => ({ items: [review] }),
    workItem: async () => answer,
  });

  it('discovers and admits an exact-hash full-contract review without magic vetting wording', async () => {
    await expect(readWorkItemReview(originalReview, {
      exists: true,
      critiquePosts: 1,
      critics: ['ebe9'],
    })).resolves.toMatchObject({
      workItemId: originalReview.id,
      criteriaHash: gcsRubric.criteriaHash,
      critics: ['ebe9'],
    });
  });

  it('still rejects stale-hash, self-authored, and unanswered reviews', async () => {
    const staleReview = {
      ...originalReview,
      summary: `Review ${gcsRubric.rubricId} criteriaHash: stale`,
    };
    await expect(readWorkItemReview(staleReview, {
      exists: true,
      critiquePosts: 1,
      critics: ['ebe9'],
    })).resolves.toBeNull();

    for (const answer of [
      { exists: true, critiquePosts: 1, critics: ['su-rubric-author'] },
      { exists: true, critiquePosts: 0, critics: ['ebe9'] },
    ]) {
      await expect(readWorkItemReview(originalReview, answer)).resolves.toBeNull();
    }
  });
});
