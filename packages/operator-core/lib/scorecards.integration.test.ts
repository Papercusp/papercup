/**
 * scorecards.integration.test.ts — the scorecard READ surface end-to-end against
 * real migrated Postgres (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * Proves what a mock-SQL unit test can't: that `listScorecards` actually reads
 * rubric-graded observations back out of `engineer_issues.payload.observation`
 * (the WRITE-only gap D-005 found), filters by rubricRef + sourceHive + a since
 * window, sorts created_at DESC, and computes nKeys/missingKeys against the live
 * rubric store (getRubric) — including the partial-scorecard case P-014's
 * completeness gate hangs on. Scorecards are written via the real createIssue
 * path; created_at is then pinned so the ordering + since assertions are
 * deterministic. Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// getOrgPg for the reads; withWorkspace for the re-pointed proposeRubric write path
// (withPlanLock → withWorkspace, P-007). The advisory xact-lock needs a real
// transaction — `.begin` provides one against the migrated throwaway DB's admin client.
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
    (h.sql as postgres.Sql).begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx as unknown as postgres.Sql);
    }) as Promise<T>,
}));

const { builtInCriterionKeysForRubric, listScorecards, scorecardTrend } = await import('./scorecards');
const { createIssue } = await import('./issues-engineer');
const { proposeRubric } = await import('./rubrics');
const { OBSERVATION_TOPIC } = await import('./harness/improvements/read-items');
const { createOrgTestDb } = await import('../test/_org-test-db');

const RUBRIC = 'test-coord-health';
const CRITERIA = [
  { key: 'end-to-end-flow', title: 'End-to-end flow', model: 'work flows', method: 'count placements', driftMarkers: 'stuck frontier' },
  { key: 'ideation-quality', title: 'Ideation quality', model: 'good ideas', method: 'grade ideas', driftMarkers: 'stale ideas' },
  { key: 'watchdog-determinism', title: 'Watchdog determinism', model: 'deterministic', method: 'replay', driftMarkers: 'flaky red-tests' },
];

/** File a scorecard via the real write path, then pin its created_at deterministically. */
async function fileScorecard(
  db: OrgTestDb,
  opts: { id: string; rubricRef?: string; sourceHive?: string; ratings: Record<string, { rating: string; evidence: string }>; createdAt: string; createdBy?: string },
): Promise<string> {
  const issue = await createIssue({
    title: `scorecard ${opts.id}`,
    kind: 'change',
    topics: [OBSERVATION_TOPIC],
    createdBy: opts.createdBy ?? 'kettle',
    payload: {
      observation: {
        ...(opts.rubricRef ? { rubricRef: opts.rubricRef } : {}),
        ...(opts.sourceHive ? { sourceHive: opts.sourceHive } : {}),
        ratings: opts.ratings,
      },
    },
  });
  await db.adminSql`UPDATE harness_shared.engineer_issues SET created_at = ${opts.createdAt} WHERE issue_id = ${issue.id}`;
  return issue.id;
}

describe('listScorecards (P-013) — real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // Seed an ACTIVE test rubric (3 criteria) so missingKeys resolves.
    await proposeRubric({
      rubricId: RUBRIC,
      characteristic: 'hive-coordination',
      title: 'Test coord health',
      criteria: CRITERIA,
      status: 'active',
      by: 'su-test',
    });

    // A COMPLETE papercusp scorecard (all 3 criteria), newest.
    await fileScorecard(db, {
      id: 'complete', rubricRef: RUBRIC, sourceHive: 'papercusp', createdAt: '2026-06-20T12:00:00.000Z',
      ratings: {
        'end-to-end-flow': { rating: 'broken', evidence: '88 unplaced' },
        'ideation-quality': { rating: 'healthy', evidence: 'fresh ideas' },
        'watchdog-determinism': { rating: 'degraded', evidence: '2 flaky red-tests' },
      },
    });
    // A PARTIAL papercusp scorecard (1 of 3) — the drift P-014 must catch.
    await fileScorecard(db, {
      id: 'partial', rubricRef: RUBRIC, sourceHive: 'papercusp', createdAt: '2026-06-20T10:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'slow' } },
    });
    // Same rubric, DIFFERENT source-hive (separate by sourceHive filter).
    await fileScorecard(db, {
      id: 'generic', rubricRef: RUBRIC, sourceHive: 'generic-test', createdAt: '2026-06-20T11:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'fine' } },
    });
    // A scorecard against an UNKNOWN rubric — rubricResolved must be false.
    await fileScorecard(db, {
      id: 'unknown-rubric', rubricRef: 'no-such-rubric', sourceHive: 'papercusp', createdAt: '2026-06-20T09:00:00.000Z',
      ratings: { 'whatever': { rating: 'healthy', evidence: 'x' } },
    });
    // A FREE-TEXT observation (no rubricRef) — must NOT appear as a scorecard.
    await createIssue({
      title: 'free-text obs', kind: 'change', topics: [OBSERVATION_TOPIC], createdBy: 'cup',
      payload: { observation: { kind: 'friction', scope: 'papercusp', refs: [] } },
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('returns only rubric-graded scorecards (free-text observations excluded), newest-first', async () => {
    const rows = await listScorecards({});
    const ids = rows.map((r) => r.rubricRef);
    expect(rows.length).toBe(4); // complete + partial + generic + unknown-rubric; free-text excluded
    expect(ids.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    // created_at DESC: complete(12:00) > generic(11:00) > partial(10:00) > unknown(09:00)
    expect(rows.map((r) => r.createdAt)).toEqual([
      '2026-06-20T12:00:00.000Z',
      '2026-06-20T11:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
      '2026-06-20T09:00:00.000Z',
    ]);
  });

  it('projects createdBy + sourceHive + nKeys, and computes missingKeys against the rubric', async () => {
    const rows = await listScorecards({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T10:00:00.000Z']); // complete, partial

    const complete = rows[0];
    expect(complete.createdBy).toBe('kettle');
    expect(complete.sourceHive).toBe('papercusp');
    expect(complete.nKeys).toBe(3);
    expect(complete.missingKeys).toEqual([]); // all 3 criteria rated
    expect(complete.rubricResolved).toBe(true);
    expect(complete.ratings['end-to-end-flow']).toEqual({ rating: 'broken', evidence: '88 unplaced' });

    const partial = rows[1];
    expect(partial.nKeys).toBe(1);
    expect(partial.missingKeys).toEqual(['ideation-quality', 'watchdog-determinism']); // unrated, in rubric order
    expect(partial.rubricResolved).toBe(true);
  });

  it('filters by sourceHive — same rubric, different hive is a separate result', async () => {
    const rows = await listScorecards({ rubricRef: RUBRIC, sourceHive: 'generic-test' });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceHive).toBe('generic-test');
    expect(rows[0].nKeys).toBe(1);
    expect(rows[0].missingKeys).toEqual(['ideation-quality', 'watchdog-determinism']);
  });

  it('filters by the since time-window (created_at >= since)', async () => {
    const rows = await listScorecards({ since: '2026-06-20T10:30:00.000Z' });
    // Only complete(12:00) + generic(11:00) are at/after 10:30.
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T11:00:00.000Z']);
  });

  it('an unknown rubric yields rubricResolved=false + empty missingKeys (never a false "complete")', async () => {
    const rows = await listScorecards({ rubricRef: 'no-such-rubric' });
    expect(rows).toHaveLength(1);
    expect(rows[0].rubricResolved).toBe(false);
    expect(rows[0].missingKeys).toEqual([]); // can't compute — but rubricResolved=false flags it
    expect(rows[0].nKeys).toBe(1);
  });

  it('has a built-in completeness fallback only for the owner-mandated hive coordination rubric', () => {
    expect(builtInCriterionKeysForRubric('hive-coordination-health')).toHaveLength(14);
    expect(builtInCriterionKeysForRubric('hive-coordination-health')).toContain('scheduler-usage');
    expect(builtInCriterionKeysForRubric('no-such-rubric')).toBeNull();
  });

  it('respects the limit (newest-first)', async () => {
    const rows = await listScorecards({ limit: 2 });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T11:00:00.000Z']);
  });

  // ── scorecardTrend (P-010) — end-to-end aggregation over the same seeded data.
  //    papercusp end-to-end-flow: partial(10:00, degraded) → complete(12:00, broken) = worsening.
  it('scorecardTrend: groups per criterion, RLE series when requested, worsening direction (P-010)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp', includeSeries: true });
    expect(trend.rubricRef).toBe(RUBRIC);
    expect(trend.sourceHive).toBe('papercusp');
    expect(trend.scorecardCount).toBe(2); // complete + partial (generic-test excluded by sourceHive)
    expect(trend.window).toEqual({ from: '2026-06-20T10:00:00.000Z', to: '2026-06-20T12:00:00.000Z' });
    // criteria sorted ASC by key.
    expect(trend.criteria.map((c) => c.criterion)).toEqual(['end-to-end-flow', 'ideation-quality', 'watchdog-determinism']);

    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    expect(e2e.count).toBe(2);
    // WI-2943: the series is RLE runs (oldest first), opt-in via includeSeries.
    expect(e2e.series).toEqual([
      { rating: 'degraded', from: '2026-06-20T10:00:00.000Z', to: '2026-06-20T10:00:00.000Z', n: 1 },
      { rating: 'broken', from: '2026-06-20T12:00:00.000Z', to: '2026-06-20T12:00:00.000Z', n: 1 },
    ]);
    expect(e2e.first).toEqual({ rating: 'degraded', at: '2026-06-20T10:00:00.000Z' });
    expect(e2e.latest).toEqual({ rating: 'broken', at: '2026-06-20T12:00:00.000Z' });
    expect(e2e.direction).toBe('worsening');
    expect(e2e.distribution).toEqual({ degraded: 1, broken: 1 });
    expect(e2e.idleCount).toBe(0); // no idle-tagged unknowns seeded

    // Single-point criteria (only the complete scorecard rated them) → unknown direction.
    const single = trend.criteria.find((c) => c.criterion === 'ideation-quality')!;
    expect(single.count).toBe(1);
    expect(single.direction).toBe('unknown');
  });

  it('scorecardTrend: series is OMITTED by default (WI-2943 — summary fields are the payload)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    expect(trend.criteria.length).toBeGreaterThan(0);
    for (const c of trend.criteria) expect(c.series).toBeUndefined();
    // The summary fields still fully describe the criterion.
    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    expect(e2e.direction).toBe('worsening');
    expect(e2e.distribution).toEqual({ degraded: 1, broken: 1 });
  });

  it('scorecardTrend: cross-hive (no sourceHive) folds every source into one series', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, includeSeries: true });
    expect(trend.scorecardCount).toBe(3); // papercusp complete + partial + generic-test
    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    // degraded(10:00, papercusp) → healthy(11:00, generic) → broken(12:00, papercusp): net first→latest = worsening.
    expect(e2e.count).toBe(3);
    expect(e2e.series!.map((p) => p.rating)).toEqual(['degraded', 'healthy', 'broken']);
    expect(e2e.series!.every((p) => p.n === 1)).toBe(true);
    expect(e2e.direction).toBe('worsening');
  });
});
