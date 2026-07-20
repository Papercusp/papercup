import { beforeEach, describe, expect, it, vi } from 'vitest';

const listIssues = vi.fn();
const countIssues = vi.fn();
vi.mock('../issues-engineer', () => ({
  listIssues: (...args: unknown[]) => listIssues(...args),
  countIssues: (...args: unknown[]) => countIssues(...args),
}));
vi.mock('../harness/improvements/read-items', () => ({
  OBSERVATION_TOPIC: 'papercusp-observation',
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { computeLearningObservations } from './learning-observations-read';
import { readListTotal } from './list-meta';

const issue = (id: string, createdAt: string) => ({
  id,
  title: `Observation ${id}`,
  body: `Body ${id}`,
  scope: 'operator',
  createdAt,
  payload: {
    sourceRole: 'worker',
    observation: { kind: 'friction', confidence: 'high', refs: ['plan:test'] },
  },
});

beforeEach(() => {
  listIssues
    .mockReset()
    .mockResolvedValue([issue('EI-2', '2026-07-11T12:00:00.000Z'), issue('EI-1', '2026-07-10T12:00:00.000Z')]);
  countIssues.mockReset().mockResolvedValue(725);
});

describe('learning.observations — Work Queue pagination contract', () => {
  // Since phase2 P-005 the compute lives in the shared computeLearningObservations
  // (the default view is served from a precomputed snapshot; see
  // learning-observations-queries.test.ts for the resolver gate). Pin the
  // total/sort/args contract against that function directly.
  it('is registered', () => {
    expect(knownQueryNamesV2()).toContain('learning.observations');
  });

  it('carries the authoritative store total on the flat row list, newest-first', async () => {
    const rows = await computeLearningObservations({ limit: 200 });

    expect(listIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation', limit: 200 });
    expect(countIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation' });
    expect(readListTotal(rows as Array<Record<string, unknown>>)).toBe(725);
    expect((rows as Array<{ id: string }>).map((row) => row.id)).toEqual(['EI-2', 'EI-1']);
  });

  it('clamps an over-large window instead of rejecting the query (non-default → inline)', async () => {
    // A state filter makes this a NON-default view → the resolver takes the live
    // inline path AND applies the argsSchema clamp (50000 → 2000) before compute.
    await resolveNamedQueryV2('learning.observations', { state: 'open', limit: 50_000 });
    expect(listIssues).toHaveBeenCalledWith({
      topic: 'papercusp-observation',
      state: 'open',
      limit: 2000,
    });
    expect(countIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation', state: 'open' });
  });
});
