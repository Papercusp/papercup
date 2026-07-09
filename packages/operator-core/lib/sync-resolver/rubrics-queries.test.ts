// rubrics.* / scorecards.* sync-resolver entries (rubrics-tab-scorecard-ui-2026-07-09
// P-001..P-003): the Rubrics tab's list + per-rubric rollup, the raw scorecard
// history (full ratings — the click-into-detail view reads the SAME rows), and the
// per-criterion trend. Store reads (lib/rubrics.ts / lib/scorecards.ts) are mocked
// at their module boundary so no PG IO runs; the rollup grouping — the only logic
// that lives IN the resolver — is what these tests pin down.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

function scorecard(rubricRef: string, createdAt: string, issueId = 'EI-1') {
  return {
    issueId,
    createdAt,
    createdBy: 'su-x',
    rubricRef,
    ratings: { crit_a: { rating: 'pass', evidence: 'e' } },
    nKeys: 1,
    missingKeys: [],
    rubricResolved: true,
    synthesized: false,
  };
}

describe('rubrics.* / scorecards.* resolvers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../rubrics');
    vi.doUnmock('../scorecards');
    vi.resetModules();
  });

  it('registers all three query names in the v2 registry', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('rubrics.list');
    expect(names).toContain('scorecards.list');
    expect(names).toContain('rubrics.trend');
  });

  it('rubrics.list groups scorecards per rubric: count + newest createdAt; 0/null when ungraded', async () => {
    const listRubrics = vi.fn(async () => [
      {
        rubricId: 'su-agent-behavior',
        characteristic: 'agent-behavior',
        title: 'SU agent behavior',
        status: 'ratified',
        criteria: [{ key: 'a' }, { key: 'b' }],
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        methodRef: null,
        updatedAt: '2026-07-09T00:00:00Z',
      },
      {
        rubricId: 'never-graded',
        characteristic: 'x',
        title: 'Never graded',
        status: 'proposed',
        criteria: [{ key: 'a' }],
        ratingScale: ['healthy', 'broken'],
        methodRef: 'm',
        updatedAt: '2026-07-08T00:00:00Z',
      },
    ]);
    const listScorecards = vi.fn(async () => [
      // newest-first, as the real store returns — grouping must keep the MAX
      // createdAt regardless of order.
      scorecard('su-agent-behavior', '2026-07-09T12:00:00Z', 'EI-2'),
      scorecard('su-agent-behavior', '2026-07-09T15:00:00Z', 'EI-3'),
      scorecard('su-agent-behavior', '2026-07-08T09:00:00Z', 'EI-1'),
      scorecard('some-other-rubric-not-listed', '2026-07-09T18:00:00Z', 'EI-4'),
    ]);
    vi.doMock('../rubrics', () => ({ listRubrics }));
    vi.doMock('../scorecards', () => ({ listScorecards }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = (await r('rubrics.list', {})) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    const graded = out.find((row) => row.rubricId === 'su-agent-behavior')!;
    expect(graded.scorecardCount).toBe(3);
    expect(graded.latestScorecardAt).toBe('2026-07-09T15:00:00Z'); // max, not first
    expect(graded.criteriaCount).toBe(2);
    const ungraded = out.find((row) => row.rubricId === 'never-graded')!;
    expect(ungraded.scorecardCount).toBe(0);
    expect(ungraded.latestScorecardAt).toBeNull();
  });

  it('scorecards.list threads rubricRef + a clamped limit to the store read', async () => {
    const listScorecards = vi.fn(async () => [scorecard('r-1', '2026-07-09T00:00:00Z')]);
    vi.doMock('../scorecards', () => ({ listScorecards }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('scorecards.list', { rubricRef: 'r-1' });
    expect(out).toHaveLength(1);
    expect(listScorecards).toHaveBeenCalledWith({ rubricRef: 'r-1', limit: 100 }); // the default
  });

  it('scorecards.list rejects a missing rubricRef (arg validation)', async () => {
    const { resolveNamedQueryV2: r } = await import('./index');
    await expect(r('scorecards.list', {})).rejects.toThrow();
  });

  it('rubrics.trend wraps the single trend object as a one-row array (useSyncQuery contract)', async () => {
    const trend = {
      rubricRef: 'r-1',
      scorecardCount: 2,
      window: { from: '2026-07-08T00:00:00Z', to: '2026-07-09T00:00:00Z' },
      criteria: [],
    };
    const scorecardTrend = vi.fn(async () => trend);
    vi.doMock('../scorecards', () => ({ scorecardTrend }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('rubrics.trend', { rubricRef: 'r-1' });
    expect(out).toEqual([trend]);
    expect(scorecardTrend).toHaveBeenCalledWith({ rubricRef: 'r-1' });
  });

  it('is bridged for SSE invalidation off both backing tables', () => {
    // A new scorecard is a work_items write (engineer_issues is a compat view);
    // a rubric create/edit is a harness_plans write (rubrics are plan-doc-backed).
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_items']).toContain('rubrics.list');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_items']).toContain('scorecards.list');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_items']).toContain('rubrics.trend');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_plans']).toContain('rubrics.list');
  });
});
