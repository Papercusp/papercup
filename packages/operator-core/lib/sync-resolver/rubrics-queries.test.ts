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
import { readListMeta } from './list-meta';
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
  beforeEach(() => {
    vi.resetModules();
    readDerivedSnapshotRowsMock.mockReset();
    readDerivedSnapshotRowsMock.mockImplementation(async () => []);
    registerDerivedReadMock.mockReset();
  });
  afterEach(() => {
    vi.doUnmock('../rubrics');
    vi.doUnmock('../scorecards');
    vi.resetModules();
  });

  it('registers all four query names in the v2 registry', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('rubrics.list');
    expect(names).toContain('scorecards.list');
    expect(names).toContain('scorecards.summary');
    expect(names).toContain('rubrics.trend');
  });

  it('rubrics.list wraps the precomputed derived-read snapshot (WI-5460) — never computes on read', async () => {
    // The rollup itself (per-rubric count/latest/avg, WI-5415's true-count fix) is
    // pinned against the producer's compute() in derived-reads/producers.test.ts;
    // this only pins that the resolver delegates to the snapshot read rather than
    // recomputing inline.
    const rows = [{ rubricId: 'su-agent-behavior', scorecardCount: 3 }];
    readDerivedSnapshotRowsMock.mockImplementation(async () => rows);
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('rubrics.list', {});

    expect(out).toBe(rows);
    expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('rubrics.list');
  });

  it('scorecards.list threads rubricRef + a clamped limit to the store read', async () => {
    const listScorecardPage = vi.fn(async () => ({
      rows: [scorecard('r-1', '2026-07-09T00:00:00Z')],
      hasMore: false,
    }));
    vi.doMock('../scorecards', () => ({ listScorecardPage }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('scorecards.list', { rubricRef: 'r-1' });
    expect(out).toHaveLength(1);
    expect(readListMeta(out as Array<Record<string, unknown>>)).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    // WI-6124/D-015: links are OPT-IN at the store, and this resolver feeds the UI
    // scorecard list, which renders them — so it MUST opt in. Asserting `includeLinks`
    // here (rather than loosening to objectContaining) makes this the regression guard
    // for a call site silently dropping the opt-in and re-introducing the empty-links UI.
    expect(listScorecardPage).toHaveBeenCalledWith({
      rubricRef: 'r-1',
      limit: 100,
      includeLinks: true,
    });
  });

  it('scorecards.summary reuses the exact aggregate and preserves zero', async () => {
    const scorecardTotalCountsByRubric = vi.fn(async () => ({ 'r-1': 0 }));
    vi.doMock('../scorecards', () => ({ scorecardTotalCountsByRubric }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('scorecards.summary', { rubricRef: 'r-1' });

    expect(out).toEqual([expect.objectContaining({ total: 0, matched: 0 })]);
    expect(scorecardTotalCountsByRubric).toHaveBeenCalledWith({
      rubricRef: 'r-1',
      includeSuperseded: false,
      includeRetracted: false,
    });
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
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_items']).toContain('scorecards.summary');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_items']).toContain('rubrics.trend');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_plans']).toContain('rubrics.list');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_plans']).toContain('scorecards.list');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_plans']).toContain('scorecards.summary');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_plans']).toContain('rubrics.trend');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_links']).toContain('scorecards.list');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_links']).toContain('scorecards.summary');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_links']).toContain('rubrics.trend');
  });
});
