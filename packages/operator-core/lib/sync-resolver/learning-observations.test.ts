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
  listIssues.mockReset().mockResolvedValue([
    issue('EI-2', '2026-07-11T12:00:00.000Z'),
    issue('EI-1', '2026-07-10T12:00:00.000Z'),
  ]);
  countIssues.mockReset().mockResolvedValue(725);
});

describe('learning.observations — Work Queue pagination contract', () => {
  it('is registered and carries the authoritative store total on the flat row list', async () => {
    expect(knownQueryNamesV2()).toContain('learning.observations');
    const rows = await resolveNamedQueryV2('learning.observations', { limit: 200 });

    expect(listIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation', limit: 200 });
    expect(countIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation' });
    expect(readListTotal(rows as Array<Record<string, unknown>>)).toBe(725);
    expect((rows as Array<{ id: string }>).map((row) => row.id)).toEqual(['EI-2', 'EI-1']);
  });

  it('clamps an over-large window instead of rejecting the query', async () => {
    await resolveNamedQueryV2('learning.observations', { state: 'open', limit: 50_000 });
    expect(listIssues).toHaveBeenCalledWith({
      topic: 'papercusp-observation',
      state: 'open',
      limit: 2000,
    });
    expect(countIssues).toHaveBeenCalledWith({ topic: 'papercusp-observation', state: 'open' });
  });
});
