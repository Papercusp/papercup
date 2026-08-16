/**
 * corpus-digest-deps.test.ts — the observations() reader's ACCEPTANCE-kind exclusion
 * (P-005/D-004 of observation-lane-scorecard-classification-2026-08-16).
 *
 * An acceptance scorecard is a plan's definition-of-done verdict: graded once,
 * retired with its plan. Folding it into the recurring-scorecard corpus pollutes
 * rubric TRENDS meant for repeated health measurements — the 01a0031d finding.
 * The reader resolves each distinct rubricRef's kind via getRubric (explicit id
 * resolves ANY kind, rubrics plan D-010) and drops `kind: 'acceptance'` records;
 * everything unresolvable or faulting RETAINS (fail-open — not proven acceptance).
 *
 * The end-to-end PG path for the KEEP side stays covered by
 * corpus-digest-deps.integration.test.ts; this file pins the exclusion logic.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scout/corpus-digest-deps.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../harness/improvements/read-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/improvements/read-items')>()),
  readObservationItems: vi.fn(),
}));
vi.mock('../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rubrics')>()),
  getRubric: vi.fn(),
  listRubrics: vi.fn(async () => []),
}));

import { readObservationItems } from '../harness/improvements/read-items';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { getRubric, type Rubric } from '../rubrics';
import { buildStateOfHiveReaders } from './corpus-digest-deps';

const readM = vi.mocked(readObservationItems);
const getRubricM = vi.mocked(getRubric);

/** A rubric-graded observation candidate as readObservationItems surfaces it.
 *  The `observation` view is read STRUCTURALLY by the reader (see corpus-digest-deps's
 *  ObservationView note), hence the unknown-bridge rather than the typed field. */
const scorecard = (id: string, rubricRef: string): ImprovementCandidate =>
  ({
    id,
    title: `Scorecard ${id}`,
    observation: { rubricRef, ratings: { 'crit-a': { rating: 'healthy', evidence: 'measured' } } },
    updatedAt: '2026-08-16T00:00:00.000Z',
  }) as unknown as ImprovementCandidate;

/** Minimal rubric fixture — only rubricId/kind are read by the exclusion. */
const rubric = (rubricId: string, kind: 'standard' | 'acceptance'): Rubric =>
  ({ rubricId, kind }) as unknown as Rubric;

beforeEach(() => {
  vi.clearAllMocks();
  getRubricM.mockResolvedValue(null);
});

describe('observations() — acceptance-kind exclusion (D-004)', () => {
  it('drops acceptance-kind scorecards and keeps standard-kind ones', async () => {
    readM.mockResolvedValue([scorecard('EI-1', 'plan-x-acceptance'), scorecard('EI-2', 'pot-health')]);
    getRubricM.mockImplementation(async (ref: string) =>
      ref === 'plan-x-acceptance' ? rubric(ref, 'acceptance') : rubric(ref, 'standard'),
    );
    const records = await buildStateOfHiveReaders().observations();
    expect(records.map((r) => r.id)).toEqual(['EI-2']);
  });

  it('RETAINS a record whose rubric no longer resolves — unproven is not acceptance', async () => {
    readM.mockResolvedValue([scorecard('EI-3', 'ghost-rubric')]);
    getRubricM.mockResolvedValue(null);
    const records = await buildStateOfHiveReaders().observations();
    expect(records.map((r) => r.id)).toEqual(['EI-3']);
  });

  it('a resolver FAULT fails open — the corpus read must not narrow on an outage', async () => {
    readM.mockResolvedValue([scorecard('EI-4', 'flaky-rubric')]);
    getRubricM.mockRejectedValue(new Error('pg down'));
    const records = await buildStateOfHiveReaders().observations();
    expect(records.map((r) => r.id)).toEqual(['EI-4']);
  });

  it('resolves each DISTINCT rubricRef once per call (cached), not once per record', async () => {
    readM.mockResolvedValue([
      scorecard('EI-5', 'pot-health'),
      scorecard('EI-6', 'pot-health'),
      scorecard('EI-7', 'other-rubric'),
    ]);
    getRubricM.mockResolvedValue(rubric('r', 'standard'));
    const records = await buildStateOfHiveReaders().observations();
    expect(records).toHaveLength(3);
    expect(getRubricM).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: free-text observations (no rubricRef) never reach the resolver at all', async () => {
    readM.mockResolvedValue([{ id: 'EI-8', title: 'plain friction' } as unknown as ImprovementCandidate]);
    const records = await buildStateOfHiveReaders().observations();
    expect(records).toEqual([]);
    expect(getRubricM).not.toHaveBeenCalled();
  });
});
