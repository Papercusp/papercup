/**
 * list.test.ts — rubrics:list summary-row truthfulness (EI-18747374149839438).
 *
 * rubrics:list returns SUMMARY rows (criteriaCount, not the full criteria array) —
 * rubrics:get is for the full body. This pins the recurrence guard that bug asked
 * for: for a rubric with N>0 criteria, the summary row (a) reports
 * criteriaCount === N and (b) never carries a bare `criteria` field a caller could
 * compute `(criteria || []).length` against and get a lying 0 — the exact failure
 * mode that nearly steered the Mug into deprecating two real, fully-authored
 * rubrics (dumb-agent-execution, stretch-discipline) as if their standard didn't
 * exist.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../rubrics', () => ({ listRubrics: vi.fn() }));

import { listRubrics } from '../../rubrics';
const listM = vi.mocked(listRubrics);

const listTool = (await import('./list')).default;

const bodyOf = async (args: unknown) => {
  const out = (await listTool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0].text);
};

const rubric = (rubricId: string, criteriaCount: number) => ({
  rubricId,
  workspaceId: 'default',
  characteristic: 'agent-execution',
  title: rubricId,
  description: '',
  criteria: Array.from({ length: criteriaCount }, (_, i) => ({ key: `c${i}`, title: `c${i}`, model: '', method: '' })),
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active' as const,
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => vi.clearAllMocks());

describe('rubrics:list — criteriaCount truthfulness', () => {
  it('a fully-authored rubric (N>0 criteria) reports criteriaCount === N, never 0', async () => {
    listM.mockResolvedValue([rubric('dumb-agent-execution', 6), rubric('stretch-discipline', 4)] as never);
    const b = await bodyOf({});
    expect(b.ok).toBe(true);
    expect(b.rubrics.map((r: { rubricId: string; criteriaCount: number }) => [r.rubricId, r.criteriaCount])).toEqual([
      ['dumb-agent-execution', 6],
      ['stretch-discipline', 4],
    ]);
  });

  it('the summary row never carries a bare `criteria` field a caller could compute (criteria||[]).length against', async () => {
    listM.mockResolvedValue([rubric('has-criteria', 6)] as never);
    const b = await bodyOf({});
    expect(b.rubrics[0]).not.toHaveProperty('criteria');
    // the only criteria-shaped surface on a summary row is the truthful scalar
    expect(b.rubrics[0].criteriaCount).toBe(6);
  });

  it('a genuinely criteria-less (draft) rubric still reports 0 honestly', async () => {
    listM.mockResolvedValue([rubric('empty-draft', 0)] as never);
    const b = await bodyOf({});
    expect(b.rubrics[0].criteriaCount).toBe(0);
  });
});
