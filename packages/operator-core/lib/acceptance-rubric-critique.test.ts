import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rubric } from './rubrics';
import {
  critiqueCoversRubric,
  readCurrentAcceptanceRubricCritique,
} from './acceptance-rubric-critique';

const discovery = vi.hoisted(() => ({
  consultRows: [] as Array<{ conversation_id: string; question: string; updated_at: string }>,
  workItems: [] as Array<{ id: string; title: string; summary: string; updatedAt: string }>,
  sql: vi.fn(),
  listAll: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: discovery.sql }),
}));
vi.mock('./work-items', () => ({
  listAllWorkItemsForFileExport: discovery.listAll,
  searchWorkItems: async (_query: string, options: { limit: number }) => ({
    items: discovery.workItems.slice(0, options.limit),
  }),
}));

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

  it.each([
    `Review ${rubric.rubricId}; subject plan revision11`,
    `Review amendment of ${rubric.rubricId}; prospective revision11`,
    `Review ${rubric.rubricId} revision10; proposed replacement revision11`,
  ])('refuses an unrelated or prospective revision: %s', opening => {
    expect(critiqueCoversRubric(opening, rubric, 11)).toBe(false);
  });

  it('refuses conflicting and malformed adjacent revision declarations', () => {
    expect(critiqueCoversRubric(`Vet ${rubric.rubricId} rev11 and ${rubric.rubricId} rev10`, rubric, 11)).toBe(false);
    expect(critiqueCoversRubric(`Vet ${rubric.rubricId} rev11a; subject revision11`, rubric, 11)).toBe(false);
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

  it('does not attest an answered amendment preview as the applied current revision', async () => {
    const stale = { ...candidate, request: `Review amendment of ${rubric.rubricId}; prospective revision11` };
    await expect(readCurrentAcceptanceRubricCritique(rubric, 11, {
      candidates: async () => [stale],
      consult: async () => ({ exists: true, critiquePosts: 1, critics: ['su-independent'] }),
    })).resolves.toBeNull();
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
    listReviewWorkItems: async () => [review],
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

describe('complete critique discovery', () => {
  beforeEach(() => {
    discovery.consultRows = [];
    discovery.workItems = [];
    discovery.sql.mockReset().mockImplementation(async (parts: TemplateStringsArray) =>
      /LIMIT\s+50/i.test(parts.join('')) ? discovery.consultRows.slice(0, 50) : discovery.consultRows);
    discovery.listAll.mockReset().mockImplementation(async () => discovery.workItems);
  });

  const answer = async () => ({ exists: true, critiquePosts: 1, critics: ['su-independent'] });
  const populations = [49, 50, 51, 351];

  it.each(populations)('finds a current consult after %i candidates, including tied timestamps', async count => {
    discovery.consultRows = Array.from({ length: count }, (_, index) => ({
      conversation_id: `consult-${index}`,
      question: index === count - 1 ? request : `${rubric.rubricId}@10`,
      updated_at: '2026-11-02T07:27:57.351Z',
    }));
    for (const rows of [discovery.consultRows, [...discovery.consultRows].reverse()]) {
      discovery.consultRows = rows;
      await expect(readCurrentAcceptanceRubricCritique(rubric, 11, { consult: answer }))
        .resolves.toMatchObject({ consultId: `consult-${count - 1}` });
    }
  });

  it.each(populations)('finds a current work-item review after %i candidates across repeated reads', async count => {
    discovery.workItems = Array.from({ length: count }, (_, index) => ({
      id: `review-${index}`,
      title: index === count - 1 ? request : `${rubric.rubricId}@10`,
      summary: '',
      updatedAt: '2026-11-02T07:27:57.351Z',
    }));
    for (const items of [discovery.workItems, [...discovery.workItems].reverse(), discovery.workItems]) {
      discovery.workItems = items;
      await expect(readCurrentAcceptanceRubricCritique(rubric, 11, { workItem: answer }))
        .resolves.toMatchObject({ workItemId: `review-${count - 1}` });
    }
  });

  it('propagates an unreadable candidate population instead of reporting no critique', async () => {
    discovery.listAll.mockRejectedValueOnce(new Error('review population unreadable'));
    await expect(readCurrentAcceptanceRubricCritique(rubric, 11))
      .rejects.toThrow('review population unreadable');
  });

  it('rejects an unreadable consult record rather than silently dropping it', async () => {
    discovery.consultRows = [{ conversation_id: 'current-review', question: request, updated_at: 'invalid' }];
    await expect(readCurrentAcceptanceRubricCritique(rubric, 11, { consult: answer }))
      .rejects.toThrow('Unreadable acceptance rubric critique candidate: current-review');
  });
});
