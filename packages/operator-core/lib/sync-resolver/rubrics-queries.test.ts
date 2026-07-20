// rubrics.* / scorecards.* sync-resolver entries (rubrics-tab-scorecard-ui-2026-07-09
// P-001..P-003): the Rubrics tab's list + per-rubric rollup, the raw scorecard
// history (full ratings — the click-into-detail view reads the SAME rows), and the
// per-criterion trend. Store reads (lib/rubrics.ts / lib/scorecards.ts) are mocked
// at their module boundary so no PG IO runs.
//
// precompute-derived-sync-reads-2026-07-19 (WI-5460): `rubrics.list`'s per-rubric
// rollup no longer runs on the resolver's read path — it moved to the
// `rubrics.list` derived-read PRODUCER (derived-reads/producers.ts), and the
// resolver here just wraps `readDerivedSnapshotRows('rubrics.list')` (see
// registry.ts's D-003 "a read never computes"). The rollup behavior itself is now
// pinned in `derived-reads/producers.test.ts`, against the producer's `compute()`
// directly; this file only pins the resolver's DELEGATION to the snapshot read,
// mirroring the dev.* precedent in `dev-glances.test.ts` (EI-17139) — a hoisted
// `vi.mock` is required so the resolver's dynamic `await import(...)` cannot race
// past a per-test `vi.doMock` and hit the real DB-backed registry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

const { readDerivedSnapshotRowsMock, registerDerivedReadMock } = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
}));
vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));

function scorecard(rubricRef: string, createdAt: string, issueId = 'EI-1', score10: number | null = 10) {
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
    score10,
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

  it('rubrics.list rolls up PER RUBRIC: count + newest createdAt; 0/null when ungraded', async () => {
    const listRubrics = vi.fn(async () => [
      {
        rubricId: 'su-agent-behavior',
        characteristic: 'agent-behavior',
        title: 'SU agent behavior',
        status: 'ratified',
        proposedBy: 'su-author',
        ratifiedBy: 'su-ratifier',
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
        proposedBy: 'su-author',
        ratifiedBy: null,
        criteria: [{ key: 'a' }],
        ratingScale: ['healthy', 'broken'],
        methodRef: 'm',
        updatedAt: '2026-07-08T00:00:00Z',
      },
    ]);
    // WI-5415: scorecards are read PER RUBRIC now (not one globally-capped combined
    // read) — a query for 'never-graded' must NOT see 'su-agent-behavior's rows, and
    // vice versa, regardless of which rubric has more recent/more numerous grading.
    const byRubric: Record<string, unknown[]> = {
      'su-agent-behavior': [
        // newest-first, as the real store returns — grouping must keep the MAX
        // createdAt regardless of order. score10s: 4 / 10 / null → avg (4+10)/2 = 7,
        // the null (all-unknown) scorecard EXCLUDED; latestScore10 rides EI-3 (max at).
        scorecard('su-agent-behavior', '2026-07-09T12:00:00Z', 'EI-2', 4),
        scorecard('su-agent-behavior', '2026-07-09T15:00:00Z', 'EI-3', 10),
        scorecard('su-agent-behavior', '2026-07-08T09:00:00Z', 'EI-1', null),
      ],
      'never-graded': [],
    };
    const listScorecards = vi.fn(async ({ rubricRef }: { rubricRef: string }) => byRubric[rubricRef] ?? []);
    const scorecardTotalCountsByRubric = vi.fn(async () => ({ 'su-agent-behavior': 3 }));
    vi.doMock('../rubrics', () => ({ listRubrics }));
    vi.doMock('../scorecards', () => ({ listScorecards, scorecardTotalCountsByRubric }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = (await r('rubrics.list', {})) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    // scoped per-rubric, never a shared/global read.
    expect(listScorecards).toHaveBeenCalledWith({ rubricRef: 'su-agent-behavior', limit: 500 });
    expect(listScorecards).toHaveBeenCalledWith({ rubricRef: 'never-graded', limit: 500 });
    const graded = out.find((row) => row.rubricId === 'su-agent-behavior')!;
    expect(graded.scorecardCount).toBe(3); // from the TRUE-count map, not cards.length
    expect(graded.latestScorecardAt).toBe('2026-07-09T15:00:00Z'); // max, not first
    expect(graded.criteriaCount).toBe(2);
    expect(graded.avgScore10).toBe(7); // (4+10)/2 — the null-scored card excluded
    expect(graded.latestScore10).toBe(10); // rides the newest-createdAt scorecard
    // WI-4506: governance provenance passes through so the UI can surface author≠ratifier.
    expect(graded.status).toBe('ratified');
    expect(graded.proposedBy).toBe('su-author');
    expect(graded.ratifiedBy).toBe('su-ratifier');
    const ungraded = out.find((row) => row.rubricId === 'never-graded')!;
    expect(ungraded.status).toBe('proposed');
    expect(ungraded.proposedBy).toBe('su-author');
    expect(ungraded.ratifiedBy).toBeNull();
    expect(ungraded.scorecardCount).toBe(0);
    expect(ungraded.latestScorecardAt).toBeNull();
    expect(ungraded.avgScore10).toBeNull();
    expect(ungraded.latestScore10).toBeNull();
  });

  it('rubrics.list scorecardCount rides the TRUE unbounded count, not the capped per-rubric read length (WI-5415 regression)', async () => {
    // The bug this pins: a rubric with FAR more real scorecards than the per-rubric
    // read's cap (e.g. 968 real rows, only ~500 fetched for the latest/avg window)
    // must still report its TRUE total — never the length of the capped fetch, and
    // never crowded to 0 by how much some OTHER rubric was graded.
    const listRubrics = vi.fn(async () => [
      {
        rubricId: 'noisy-rubric',
        characteristic: 'x',
        title: 'Noisy',
        status: 'active',
        proposedBy: 'a',
        ratifiedBy: 'a',
        criteria: [{ key: 'a' }],
        ratingScale: ['pass', 'fail'],
        methodRef: null,
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);
    const cappedRead = Array.from({ length: 500 }, (_, i) =>
      scorecard('noisy-rubric', `2026-07-0${(i % 9) + 1}T00:00:00Z`, `EI-${i}`, 10),
    );
    const listScorecards = vi.fn(async () => cappedRead);
    const scorecardTotalCountsByRubric = vi.fn(async () => ({ 'noisy-rubric': 968 }));
    vi.doMock('../rubrics', () => ({ listRubrics }));
    vi.doMock('../scorecards', () => ({ listScorecards, scorecardTotalCountsByRubric }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = (await r('rubrics.list', {})) as Array<Record<string, unknown>>;
    expect(out[0]?.scorecardCount).toBe(968); // the true total, not 500 (cappedRead.length)
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
