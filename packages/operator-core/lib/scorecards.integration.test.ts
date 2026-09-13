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
import { composeCompanionSummary } from '@papercusp/facets';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// getOrgPg for the reads; withWorkspace for the re-pointed proposeRubric write path
// (withPlanLock → withWorkspace, P-007). The advisory xact-lock needs a real
// transaction — `.begin` provides one against the migrated throwaway DB's admin client.
//
// Spread the ACTUAL module (vi.importActual) rather than hand-listing every export:
// this test's import graph reaches multiple other db-org consumers transitively
// (agent-tools/locks/configure.ts calls setAdminPoolStatementTimeoutProvider at module
// top-level — WI-832; @papercusp/agent-mcp's bootstrap reads the `generated` schema
// namespace) and vitest throws on ANY access to an export missing from a partial mock.
// Those extra exports are pure (drizzle schema defs / a config-seam setter), so
// importing them for real has no I/O side effect — only getOrgPg/withWorkspace need
// faking to re-point reads/writes at the migrated throwaway test DB.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const {
  builtInCriterionKeysForRubric,
  listScorecardPage,
  listScorecards,
  readScorecardEvidence,
  recordGradingAudit,
  scorecardTotalCountsByRubric,
  scorecardTrend,
} = await import('./scorecards');
const { createIssue, getIssue, issueRef, issuesScopeWorkspace, linkIssue } = await import('./issues-engineer');
const { proposeRubric, setRubricHistoryReset } = await import('./rubrics');
const { OBSERVATION_TOPIC } = await import('./harness/improvements/read-items');
const { resolveLocalRubric } = await import('./cupboard/rubric-store');
const { createOrgTestDb } = await import('../test/_org-test-db');
const {
  buildScorecardHistoryPredicate,
  normalizeScorecardHistoryArgs,
  readScorecardHistoryPage,
  readScorecardHistorySummary,
} = await import('./sync-resolver/scorecard-history-list-query');

const RUBRIC = 'test-coord-health';
const CRITERIA = [
  // WI-4607: end-to-end-flow carries a trailing [instrumentKey:] token; watchdog is
  // explicitly `none`; ideation-quality carries no token (→ instrumentKey null).
  {
    key: 'end-to-end-flow',
    title: 'End-to-end flow',
    model: 'work flows [instrumentKey: placement-count]',
    method: 'count placements',
    driftMarkers: 'stuck frontier',
  },
  {
    key: 'ideation-quality',
    title: 'Ideation quality',
    model: 'good ideas',
    method: 'assess idea quality',
    driftMarkers: 'stale ideas',
  },
  {
    key: 'watchdog-determinism',
    title: 'Watchdog determinism',
    model: 'deterministic [instrumentKey: none]',
    method: 'replay',
    driftMarkers: 'flaky red-tests',
  },
];

// P-010 supersession fixture — a SEPARATE rubric so the counts/series the tests
// above assert are untouched, and deliberately dated a day EARLIER so the
// unfiltered newest-first listing just gains a tail.
//
// The shape is the real defect, not a synthetic one: a grade is filed, later
// found to be a MISREADING, and a correction is filed. Both then sat in the
// series, so the correction moved the trend twice — once for the reading now
// known to be wrong, again for the right one. Here the wrong reading is the
// OLDEST sample, which is what makes it visible: it anchors `first`, so the
// trend reports an "improvement" that is purely an artifact of the correction.
const RUBRIC_SUPERSEDE = 'test-supersession';
const SUPERSEDE_KEY = 'grading-honesty';
// ── D-015 contract-generation fixture. Deliberately SEPARATE from RUBRIC_SUPERSEDE so
// the boundary test cannot pass on a rubric whose samples another test already thinned.
const RUBRIC_RESET = 'test-contract-reset';
const RESET_KEY = 'contract-honesty';
const RESET_BOUNDARY = '2026-06-18T12:00:00.000Z';
const reset: { oldSuperseded: string; oldReviser: string; current: string } = {
  oldSuperseded: '',
  oldReviser: '',
  current: '',
};
const supersede: { original: string; correction: string; independent: string } = {
  original: '',
  correction: '',
  independent: '',
};
let roundtripScorecardId = '';

/** File a scorecard via the real write path, then pin its created_at deterministically. */
async function fileScorecard(
  db: OrgTestDb,
  opts: {
    id: string;
    rubricRef?: string;
    sourceHive?: string;
    rubricRevision?: number;
    criteriaHash?: string;
    ratings: Record<string, { rating: string; evidence: string }>;
    instrumentSnapshots?: Record<string, unknown>;
    createdAt: string;
    createdBy?: string;
  },
): Promise<string> {
  const issue = await createIssue({
    title: `scorecard ${opts.id}`,
    kind: 'change',
    topics: [OBSERVATION_TOPIC],
    createdBy: opts.createdBy ?? 'kettle',
    payload: {
      observation: {
        ...(opts.rubricRef ? { rubricRef: opts.rubricRef } : {}),
        ...(opts.rubricRevision != null ? { rubricRevision: opts.rubricRevision } : {}),
        ...(opts.criteriaHash ? { criteriaHash: opts.criteriaHash } : {}),
        ...(opts.sourceHive ? { sourceHive: opts.sourceHive } : {}),
        ratings: opts.ratings,
        ...(opts.instrumentSnapshots ? { instrumentSnapshots: opts.instrumentSnapshots } : {}),
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

    // A historically malformed papercusp scorecard: all 3 required criteria plus
    // one extra key. Direct createIssue intentionally bypasses the capture gate so
    // the read path proves old rows remain auditable without polluting trends.
    roundtripScorecardId = await fileScorecard(db, {
      id: 'complete',
      rubricRef: RUBRIC,
      rubricRevision: 17,
      criteriaHash: 'criteria-hash-roundtrip',
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T12:00:00.000Z',
      ratings: {
        'end-to-end-flow': { rating: 'broken', evidence: '88 unplaced' },
        'ideation-quality': { rating: 'healthy', evidence: 'fresh ideas' },
        'watchdog-determinism': { rating: 'degraded', evidence: '2 flaky red-tests' },
        'legacy-ad-hoc-check': { rating: 'healthy', evidence: 'old writer invented a dimension' },
      },
      instrumentSnapshots: {
        'spec-quality.proof': {
          verdict: 'pass',
          measuredAt: '2026-06-20T11:59:30.000Z',
          value: { checked: 4 },
          evidenceRef: 'test:spec-quality-proof',
        },
      },
    });
    // A malformed historical candidate still passes the SQL rubricRef/sourceHive
    // predicates, but the canonical observation parser drops its invalid rating
    // entry. Pagination must advance past this raw row without consuming a public
    // scorecard page slot or making `hasMore` read false.
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      VALUES (
        ${issuesScopeWorkspace()}, 'EI-scorecard-malformed', 'change',
        'harness:papercusp', 'malformed scorecard', '', 'minor', 'test',
        'done',
        ${JSON.stringify({
          observation: {
            rubricRef: RUBRIC,
            sourceHive: 'papercusp',
            ratings: {
              malformed: { rating: 42, evidence: null },
            },
          },
        })}::text::jsonb,
        'su-test', 'organic',
        timestamptz '2026-06-20T13:00:00Z',
        timestamptz '2026-06-20T13:00:00Z'
      )`;
    // A PARTIAL papercusp scorecard (1 of 3) — the drift P-014 must catch.
    await fileScorecard(db, {
      id: 'partial',
      rubricRef: RUBRIC,
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T10:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'slow' } },
    });
    // Same rubric, DIFFERENT source-hive (separate by sourceHive filter).
    await fileScorecard(db, {
      id: 'generic',
      rubricRef: RUBRIC,
      sourceHive: 'generic-test',
      createdAt: '2026-06-20T11:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'fine' } },
    });
    // A scorecard against an UNKNOWN rubric — rubricResolved must be false.
    await fileScorecard(db, {
      id: 'unknown-rubric',
      rubricRef: 'no-such-rubric',
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T09:00:00.000Z',
      ratings: { whatever: { rating: 'healthy', evidence: 'x' } },
    });
    // A FREE-TEXT observation (no rubricRef) — must NOT appear as a scorecard.
    await createIssue({
      title: 'free-text obs',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'cup',
      payload: { observation: { kind: 'friction', scope: 'papercusp', refs: [] } },
    });

    // ── P-010 supersession fixture (see RUBRIC_SUPERSEDE above). Seeded WITHOUT
    //    the `revises` edge: the test files it mid-way so the same trend can be
    //    read before and after, which is what proves the exclusion is
    //    load-bearing rather than coincidental.
    await proposeRubric({
      rubricId: RUBRIC_SUPERSEDE,
      characteristic: 'hive-coordination',
      title: 'Test supersession',
      criteria: [
        {
          key: SUPERSEDE_KEY,
          title: 'Grading honesty',
          model: 'grades reflect reality',
          method: 'compare to source',
          driftMarkers: 'uncorrected misreadings',
        },
      ],
      status: 'active',
      by: 'su-test',
    });
    supersede.original = await fileScorecard(db, {
      id: 'supersede-original',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T10:00:00.000Z',
      ratings: { [SUPERSEDE_KEY]: { rating: 'broken', evidence: 'ORIGINAL — the evidence was misread' } },
    });
    supersede.correction = await fileScorecard(db, {
      id: 'supersede-correction',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T11:00:00.000Z',
      ratings: {
        [SUPERSEDE_KEY]: { rating: 'healthy', evidence: 'CORRECTION — re-read the source; it was fine all along' },
      },
    });
    supersede.independent = await fileScorecard(db, {
      id: 'supersede-independent',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T12:00:00.000Z',
      ratings: { [SUPERSEDE_KEY]: { rating: 'healthy', evidence: 'a genuinely separate later observation' } },
    });

    // ── D-015 contract-generation fixture. Seeded WITHOUT a declared boundary, and
    //    WITH the `revises` edge already in place, so the test can read the same trend
    //    before and after declaring the boundary. The overlap is the point: one sample
    //    is BOTH pre-boundary AND superseded, which is the case where two independent
    //    exclusion paths can double-count the same row.
    await proposeRubric({
      rubricId: RUBRIC_RESET,
      characteristic: 'hive-coordination',
      title: 'Test contract reset',
      criteria: [
        {
          key: RESET_KEY,
          title: 'Contract honesty',
          model: 'grades measure the live contract',
          method: 'compare to contract',
          driftMarkers: 'gradings of a rewritten contract',
        },
      ],
      status: 'active',
      by: 'su-test',
    });
    reset.oldSuperseded = await fileScorecard(db, {
      id: 'reset-old-superseded',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T10:00:00.000Z',
      ratings: {
        [RESET_KEY]: { rating: 'broken', evidence: 'PRE-REWRITE, and later corrected — excluded by BOTH paths' },
      },
    });
    reset.oldReviser = await fileScorecard(db, {
      id: 'reset-old-reviser',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T11:00:00.000Z',
      ratings: { [RESET_KEY]: { rating: 'healthy', evidence: 'PRE-REWRITE correction of the above' } },
    });
    reset.current = await fileScorecard(db, {
      id: 'reset-current',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T13:00:00.000Z',
      ratings: {
        [RESET_KEY]: { rating: 'healthy', evidence: 'POST-REWRITE — the only sample that grades the live contract' },
      },
    });
    await linkIssue(reset.oldReviser, issueRef(reset.oldSuperseded), 'revises', 'su-test');
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('returns only rubric-graded scorecards (free-text observations excluded), newest-first', async () => {
    const rows = await listScorecards({});
    const ids = rows.map((r) => r.rubricRef);
    // complete + partial + generic + unknown-rubric + the 3 supersession fixtures
    // (06-19) + the 3 contract-reset fixtures (06-18); free-text excluded. NOTE
    // listScorecards is the raw READ surface and is deliberately supersession-blind —
    // the exclusion belongs to the TREND, so all 3 appear here even after the `revises`
    // edge is filed. The SAME holds for the D-015 contract-generation boundary: it is a
    // TREND-level exclusion, so a retired-contract grading is still readable here. That
    // is deliberate — the raw read is how you audit what was excluded and why, which an
    // exclusion applied at the read surface would make impossible.
    expect(rows.length).toBe(10);
    expect(ids.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    // created_at DESC: complete(12:00) > generic(11:00) > partial(10:00) > unknown(09:00)
    expect(rows.map((r) => r.createdAt)).toEqual([
      '2026-06-20T12:00:00.000Z',
      '2026-06-20T11:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
      '2026-06-20T09:00:00.000Z',
      '2026-06-19T12:00:00.000Z',
      '2026-06-19T11:00:00.000Z',
      '2026-06-19T10:00:00.000Z',
      '2026-06-18T13:00:00.000Z',
      '2026-06-18T11:00:00.000Z',
      '2026-06-18T10:00:00.000Z',
    ]);
  });

  it('projects createdBy + sourceHive + nKeys, and computes missingKeys against the rubric', async () => {
    const rows = await listScorecards({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T10:00:00.000Z']); // complete, partial

    const complete = rows[0];
    expect(complete.createdBy).toBe('kettle');
    expect(complete.sourceHive).toBe('papercusp');
    expect(complete.nKeys).toBe(4);
    expect(complete.missingKeys).toEqual([]); // all 3 criteria rated
    expect(complete.extraKeys).toEqual(['legacy-ad-hoc-check']);
    expect(complete.rubricResolved).toBe(true);
    expect(complete.rubricRevision).toBe(17);
    expect(complete.criteriaHash).toBe('criteria-hash-roundtrip');
    expect(complete.score10).toBe(5); // known criteria only: broken(0), healthy(10), degraded(5)
    expect(complete.ratings['end-to-end-flow']).toEqual({ rating: 'broken', evidence: '88 unplaced' });
    expect(complete.instrumentSnapshots).toEqual({
      'spec-quality.proof': {
        verdict: 'pass',
        measuredAt: '2026-06-20T11:59:30.000Z',
        value: { checked: 4 },
        evidenceRef: 'test:spec-quality-proof',
      },
    });

    const partial = rows[1];
    expect(partial.nKeys).toBe(1);
    expect(partial.missingKeys).toEqual(['ideation-quality', 'watchdog-determinism']); // unrated, in rubric order
    expect(partial.extraKeys).toEqual([]);
    expect(partial.rubricResolved).toBe(true);
  });

  it('round-trips the substantive rubric identity through the evidence-first reader', async () => {
    const result = await readScorecardEvidence(roundtripScorecardId);

    expect(result).toMatchObject({
      kind: 'found',
      scorecard: {
        issueId: roundtripScorecardId,
        rubricRevision: 17,
        criteriaHash: 'criteria-hash-roundtrip',
      },
    });
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
    expect(rows[0].extraKeys).toEqual([]); // unknown rubric ⇒ no declared key set to compare
    expect(rows[0].nKeys).toBe(1);
  });

  it('has a built-in completeness fallback only for the owner-mandated hive coordination rubric', () => {
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toHaveLength(15);
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toContain('scheduler-usage');
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toContain('context-burn');
    expect(builtInCriterionKeysForRubric('no-such-rubric')).toBeNull();
  });

  // EI-13292 recurrence guard: the built-in fallback drifted to 14 keys (missing
  // `context-burn`) after the first-party bundle (rubrics/pot-coordination-health/
  // rubric.json) was extended to 15 — a scorecard rating all 15 (correctly) then read
  // as "unexpected criterion key(s): context-burn" whenever this fallback was consulted.
  // Pin the fallback to the bundle's OWN criteria list so the two can never silently
  // diverge again.
  it('keeps the built-in fallback in lockstep with the first-party rubric bundle (EI-13292)', () => {
    const bundled = resolveLocalRubric('pot-coordination-health');
    expect(bundled).not.toBeNull();
    const bundledKeys = bundled!.criteria.map((c) => c.key);
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toEqual(bundledKeys);
  });

  it('respects the limit (newest-first)', async () => {
    const rows = await listScorecards({ limit: 2 });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T11:00:00.000Z']);
  });

  it('fills valid page slots past malformed raw rows and reports authoritative hasMore', async () => {
    const first = await listScorecardPage({ rubricRef: RUBRIC, sourceHive: 'papercusp', limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.createdAt).toBe('2026-06-20T12:00:00.000Z');
    expect(first.hasMore).toBe(true);

    const second = await listScorecardPage({
      rubricRef: RUBRIC,
      sourceHive: 'papercusp',
      limit: 1,
      before: {
        createdAt: first.rows[0]!.createdAt,
        issueId: first.rows[0]!.issueId,
      },
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.createdAt).toBe('2026-06-20T10:00:00.000Z');
    expect(second.hasMore).toBe(false);
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
    expect(trend.criteria.map((c) => c.criterion)).toEqual([
      'end-to-end-flow',
      'ideation-quality',
      'watchdog-determinism',
    ]);
    expect(trend.criteria.some((c) => c.criterion === 'legacy-ad-hoc-check')).toBe(false);

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

  it('scorecardTrend: threads governance provenance + per-criterion instrumentKey (WI-4607)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    // Governance provenance sourced from the same getRubric() read the mean10 scale uses.
    expect(trend.status).toBe('active');
    expect(typeof trend.proposedBy).toBe('string');
    expect((trend.proposedBy ?? '').length).toBeGreaterThan(0);
    // instrumentKey parsed from each criterion's trailing model token.
    const byKey = Object.fromEntries(trend.criteria.map((c) => [c.criterion, c.instrumentKey]));
    expect(byKey['end-to-end-flow']).toBe('placement-count');
    expect(byKey['watchdog-determinism']).toBe('none'); // explicit no-instrument binding
    expect(byKey['ideation-quality']).toBeNull(); // no token → null
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

  // ── P-010: a re-grade must not move the trend twice.
  //
  // Read the SAME trend before and after filing the `revises` edge. The "before"
  // half is the falsifier: without it, an assertion that the corrected trend is
  // `stable` proves nothing, because it would also pass if the fixture had simply
  // never been improving. What makes the defect real is that the direction FLIPS —
  // the reported "improvement" was entirely an artifact of correcting a bad grade.
  it('scorecardTrend: a `revises` correction supersedes the grade it corrects, and the direction it faked goes with it (P-010)', async () => {
    const before = await scorecardTrend({ rubricRef: RUBRIC_SUPERSEDE, sourceHive: 'papercusp', includeSeries: true });
    expect(before.scorecardCount).toBe(3);
    expect(before.supersededExcluded).toBe(0); // nothing revised yet — the field is honest at zero, not absent
    const beforeCriterion = before.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!;
    expect(beforeCriterion.series!.map((p) => p.rating)).toEqual(['broken', 'healthy']); // RLE: healthy(11:00)+healthy(12:00) collapse into one run
    expect(beforeCriterion.count).toBe(3);
    expect(beforeCriterion.direction).toBe('improving'); // ← the artifact: driven entirely by the misreading it later corrected
    expect(before.window).toEqual({ from: '2026-06-19T10:00:00.000Z', to: '2026-06-19T12:00:00.000Z' });

    // The correction declares what it corrects. src = the reviser, dst = the superseded.
    await linkIssue(supersede.correction, issueRef(supersede.original), 'revises', 'su-test');

    const after = await scorecardTrend({ rubricRef: RUBRIC_SUPERSEDE, sourceHive: 'papercusp', includeSeries: true });
    expect(after.scorecardCount).toBe(2); // counts only what actually fed the series
    expect(after.supersededExcluded).toBe(1); // …and says so, rather than dropping it silently
    const afterCriterion = after.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!;
    expect(afterCriterion.count).toBe(2);
    expect(afterCriterion.series!.map((p) => p.rating)).toEqual(['healthy']); // the misreading is gone from the series
    expect(afterCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-19T11:00:00.000Z' });
    expect(afterCriterion.direction).toBe('stable'); // ← the whole point: no phantom improvement
    expect(afterCriterion.distribution).toEqual({ healthy: 2 });
    // The excluded sample also stops anchoring the reported window.
    expect(after.window).toEqual({ from: '2026-06-19T11:00:00.000Z', to: '2026-06-19T12:00:00.000Z' });

    // Only the REVISED one drops — a correction chain must not take its own corrections with it.
    expect(after.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!.latest).toEqual({
      rating: 'healthy',
      at: '2026-06-19T12:00:00.000Z',
    });
  });

  // ── D-015: gradings of a REWRITTEN contract must not blend into the live trend.
  //
  // The before/after is the falsifier, same as P-010's: asserting that the post-boundary
  // trend reads 'healthy' proves nothing on its own, because the fixture's newest sample
  // is healthy anyway. What proves the exclusion is load-bearing is that the criterion's
  // SAMPLE COUNT and DIRECTION change when the boundary is declared, and that they change
  // by exactly the samples that pre-date it.
  it('scorecardTrend: a declared contract-generation boundary excludes pre-rewrite gradings, and the two exclusion paths never double-count (D-015)', async () => {
    const before = await scorecardTrend({ rubricRef: RUBRIC_RESET, sourceHive: 'papercusp', includeSeries: true });
    // No boundary declared yet, so this is the OLD behaviour: pre-rewrite gradings feed
    // the series, and the only thing thinning it is the revises edge.
    expect(before.preContractResetExcluded).toBe(0); // honest at zero, not absent — a rubric that never rewrote its contract is unaffected
    expect(before.supersededExcluded).toBe(1);
    expect(before.scorecardCount).toBe(2);
    const beforeCriterion = before.criteria.find((c) => c.criterion === RESET_KEY)!;
    expect(beforeCriterion.count).toBe(2);
    expect(beforeCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-18T11:00:00.000Z' }); // ← a PRE-rewrite grading anchoring the series

    const updated = await setRubricHistoryReset(RUBRIC_RESET, RESET_BOUNDARY, 'su-test');
    expect(updated?.historyResetAt).toBe(RESET_BOUNDARY);
    // The boundary is governance state, NOT content: declaring it must not demote a
    // ratified rubric (which a propose would). This is the assertion that fails if
    // anyone later reroutes this through amendRubric.
    expect(updated?.status).toBe('active');

    const afterReset = await scorecardTrend({ rubricRef: RUBRIC_RESET, sourceHive: 'papercusp', includeSeries: true });
    expect(afterReset.preContractResetExcluded).toBe(2); // both pre-rewrite gradings, said out loud
    expect(afterReset.scorecardCount).toBe(1); // only the sample that grades the LIVE contract
    const afterCriterion = afterReset.criteria.find((c) => c.criterion === RESET_KEY)!;
    expect(afterCriterion.count).toBe(1);
    expect(afterCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-18T13:00:00.000Z' });
    // The retired gradings stop anchoring the reported window too — a window still
    // reaching back into the old contract would reintroduce the blend in the one field
    // a reader uses to judge how current the trend is.
    expect(afterReset.window).toEqual({ from: '2026-06-18T13:00:00.000Z', to: '2026-06-18T13:00:00.000Z' });

    // THE DOUBLE-COUNT GUARD. `reset.oldSuperseded` qualifies for BOTH exclusions: it
    // pre-dates the boundary AND a later filing revises it. It must be counted ONCE.
    // supersededExcluded is measured against the post-boundary set, so it reads 0 here —
    // not because nothing was superseded, but because the only superseded row had already
    // left the population. Measuring it against the raw rows instead would report 1 here
    // and make the two figures sum to 3 exclusions out of 3 rows, with 1 row still in the
    // series: arithmetic that cannot be true, in the exact fields that exist to make the
    // thinning legible.
    expect(afterReset.supersededExcluded).toBe(0);
    expect(afterReset.preContractResetExcluded + afterReset.supersededExcluded).toBe(3 - afterReset.scorecardCount);
  });
});

describe('scorecard history P-009 — real PG large-corpus contract', () => {
  const rubricRef = 'test-large-scorecard-history';
  const criterion = 'bounded-history';
  const seededRows = 843;
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    await proposeRubric({
      rubricId: rubricRef,
      characteristic: 'hive-coordination',
      title: 'Large scorecard history',
      criteria: [
        {
          key: criterion,
          title: 'Bounded history',
          model: 'history reads stay bounded',
          method: 'page the corpus',
          driftMarkers: 'page length presented as a total',
        },
      ],
      status: 'active',
      by: 'su-test',
    });

    // Direct through the canonical issue-family compatibility view, in one
    // statement. Paired timestamps force the cursor's issue-id tie-breaker to
    // carry real correctness rather than merely decorate an all-unique fixture.
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      SELECT ${issuesScopeWorkspace()},
             'EI-p009-' || lpad(g::text, 4, '0'),
             'change',
             'harness:papercusp',
             'P-009 scorecard ' || g,
             '',
             'minor',
             'test',
             'done',
             ${JSON.stringify({
               observation: {
                 rubricRef,
                 ratings: {
                   [criterion]: {
                     rating: 'pass',
                     evidence: 'seeded large-corpus scorecard',
                   },
                 },
               },
             })}::text::jsonb,
             'su-test',
             'organic',
             timestamptz '2026-08-01T00:00:00Z'
               + floor(g / 2.0) * interval '1 second',
             timestamptz '2026-08-01T00:00:00Z'
               + floor(g / 2.0) * interval '1 second'
        FROM generate_series(1, ${seededRows}) AS g`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('keeps exact corpus truth independent from the 500-row trend sample and keyset-pages every row', async () => {
    const firstPredicate = buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef, limit: 137 }));
    const started = performance.now();
    const [aggregateRows, trend] = await Promise.all([
      readScorecardHistorySummary(firstPredicate, {
        countByRubric: scorecardTotalCountsByRubric,
      }),
      scorecardTrend({ rubricRef }),
    ]);
    const summary = composeCompanionSummary(aggregateRows);
    expect(summary).toMatchObject({ total: seededRows, matched: seededRows });
    expect(trend.sample).toEqual({ limit: 500, inputCount: 500 });
    expect(trend.scorecardCount).toBe(500);
    expect(performance.now() - started).toBeLessThan(6_000);

    const ids: string[] = [];
    let cursor: string | null = null;
    let pageNo = 0;
    let maxPageBytes = 0;
    let maxPageMs = 0;
    for (;;) {
      const pageStarted = performance.now();
      const page = await readScorecardHistoryPage(
        buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef, limit: 137, cursor })),
        { listPage: listScorecardPage },
      );
      maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page.rows)));
      ids.push(...page.rows.map((row) => row.issueId));
      cursor = page.nextCursor;

      if (pageNo === 0) {
        // A new row above the cursor must not duplicate or skip the immutable
        // snapshot prefix already traversed.
        await db.adminSql`
          INSERT INTO harness_shared.engineer_issues
            (workspace_id, issue_id, kind, scope, title, body, severity, source,
             state, payload, created_by, signal_origin, created_at, updated_at)
          VALUES (
            ${issuesScopeWorkspace()}, 'EI-p009-newer', 'change',
            'harness:papercusp', 'newer after cursor', '', 'minor', 'test',
            'done',
            ${JSON.stringify({
              observation: {
                rubricRef,
                ratings: {
                  [criterion]: { rating: 'pass', evidence: 'newer insertion' },
                },
              },
            })}::text::jsonb,
            'su-test', 'organic',
            timestamptz '2026-08-02T00:00:00Z',
            timestamptz '2026-08-02T00:00:00Z'
          )`;
      }

      pageNo += 1;
      if (!cursor) break;
      expect(pageNo).toBeLessThan(20);
    }

    expect(ids).toHaveLength(seededRows);
    expect(new Set(ids).size).toBe(seededRows);
    expect(ids).not.toContain('EI-p009-newer');
    expect(maxPageBytes).toBeLessThan(250_000);
    expect(maxPageMs).toBeLessThan(6_000);

    const updatedAggregate = await readScorecardHistorySummary(firstPredicate, {
      countByRubric: scorecardTotalCountsByRubric,
    });
    expect(composeCompanionSummary(updatedAggregate).matched).toBe(seededRows + 1);
  }, 120_000);

  it('preserves an exact zero when the history page is empty', async () => {
    const predicate = buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef: 'missing-rubric' }));
    const [page, aggregateRows] = await Promise.all([
      readScorecardHistoryPage(predicate, { listPage: listScorecardPage }),
      readScorecardHistorySummary(predicate, {
        countByRubric: scorecardTotalCountsByRubric,
      }),
    ]);
    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
    expect(composeCompanionSummary(aggregateRows)).toMatchObject({
      total: 0,
      matched: 0,
    });
  });

  it('CAS-restamps a legacy settled audit and cannot overwrite a concurrent correction', async () => {
    const target = await createIssue({
      title: 'legacy grading-audit target',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'su-target-author',
      payload: {
        observation: {
          rubricRef: RUBRIC,
          ratings: {
            'end-to-end-flow': { rating: 'healthy', evidence: 'current proof' },
          },
          gradingAudit: {
            state: 'failed',
            metaRubricRef: 'grading-integrity',
            auditIssueId: 'EI-AUDIT-OLD',
            auditor: 'su-old-auditor',
            stampedAt: '2026-09-07T00:00:00.000Z',
            auditedAt: '2026-09-07T00:01:00.000Z',
          },
        },
      },
    });
    const staleSnapshot = await getIssue(target.id);
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               payload,
               '{observation,ratings,end-to-end-flow,evidence}',
               ${JSON.stringify('concurrent proof must survive the audit CAS')}::jsonb,
               false
             )
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND feature_id = ${target.id}`;

    const winner = await recordGradingAudit(target.id, {
      auditIssueId: 'EI-AUDIT-WINNER',
      auditor: 'su-winning-auditor',
      verdict: 'passed',
      rubricRevision: 7,
      criteriaHash: 'grading-integrity-v7',
      requireCurrentIdentity: true,
      supersedesAuditIssueId: 'EI-AUDIT-OLD',
    });
    expect(winner).toMatchObject({
      ok: true,
      gradingAudit: {
        state: 'passed',
        auditIssueId: 'EI-AUDIT-WINNER',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
      },
    });

    const late = await recordGradingAudit(
      target.id,
      {
        auditIssueId: 'EI-AUDIT-LATE',
        auditor: 'su-late-auditor',
        verdict: 'failed',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
        requireCurrentIdentity: true,
        supersedesAuditIssueId: 'EI-AUDIT-OLD',
      },
      { getIssue: vi.fn(async () => staleSnapshot) as never },
    );
    expect(late).toMatchObject({ ok: false, issueId: target.id });

    const stored = await getIssue(target.id);
    const storedObservation = (
      stored?.payload as {
        observation?: {
          ratings?: Record<string, { evidence?: string }>;
          gradingAudit?: unknown;
        };
      }
    )?.observation;
    expect(storedObservation?.gradingAudit).toMatchObject({
      state: 'passed',
      auditIssueId: 'EI-AUDIT-WINNER',
      auditor: 'su-winning-auditor',
      rubricRevision: 7,
      criteriaHash: 'grading-integrity-v7',
    });
    expect(storedObservation?.ratings?.['end-to-end-flow']?.evidence).toBe(
      'concurrent proof must survive the audit CAS',
    );
  });
});
