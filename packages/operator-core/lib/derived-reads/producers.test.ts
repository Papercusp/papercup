// The rollup logic behind the `rubrics.list` derived-read producer
// (precompute-derived-sync-reads-2026-07-19 P-002 / WI-5460; rollup semantics
// from rubrics-tab-scorecard-ui-2026-07-09 P-001..P-003 / WI-5415, WI-4506).
//
// This aggregation used to live INLINE in the `rubrics.list` sync resolver and
// was pinned there (packages/operator-core/lib/sync-resolver/rubrics-queries.test.ts).
// The WI-5460 precompute migration moved the actual computation into this
// producer's `compute()` — the resolver now just does a plain snapshot SELECT
// (see registry.ts's D-003 "a read never computes") — so the rollup behavior
// must be pinned HERE, against `compute()` directly, not against the resolver.
// (The resolver's delegation-to-snapshot behavior is covered separately in
// sync-resolver/rubrics-queries.test.ts, mirroring the dev.* precedent in
// sync-resolver/dev-glances.test.ts / EI-17139.)
//
// Store reads (lib/rubrics.ts / lib/scorecards.ts) are mocked at their module
// boundary so no PG IO runs; the rollup grouping is what these tests pin down.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// NOTE: `./registry` must be imported DYNAMICALLY, after `vi.resetModules()`, in
// the same "epoch" as `./producers`'s own dynamic import of it — a top-level
// static import of `./registry` binds to the module instance loaded before any
// resetModules() call, which diverges from the fresh instance `./producers`
// registers into post-reset (its REGISTRY Map would appear empty here).
async function loadRubricsListProducer() {
  vi.resetModules();
  const registry = await import('./registry');
  registry.__clearDerivedReadRegistryForTest();
  await import('./producers');
  const producer = registry.listDerivedReadProducers().find((p) => p.key === 'rubrics.list');
  if (!producer) throw new Error('rubrics.list producer not registered');
  return producer;
}

describe('derived-reads producers: rubrics.list', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../rubrics');
    vi.doUnmock('../scorecards');
    vi.resetModules();
  });

  it('rolls up PER RUBRIC: count + newest createdAt; 0/null when ungraded', async () => {
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

    const producer = await loadRubricsListProducer();
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as Array<
      Record<string, unknown>
    >;

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

  it('scorecardCount rides the TRUE unbounded count, not the capped per-rubric read length (WI-5415 regression)', async () => {
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

    const producer = await loadRubricsListProducer();
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as Array<
      Record<string, unknown>
    >;

    expect(out[0]?.scorecardCount).toBe(968); // the true total, not 500 (cappedRead.length)
  });
});

// insights.coordTokens producer (phase2 P-002 / WI-5584). The compute wires the
// three load-token-rollups loaders inside a workspace-routed transaction and
// returns the SAME `[{ pricingBook, coordBreakdown, pollVolume }]` shape the
// resolver used to build inline. The only invariant worth pinning here (beyond
// the loaders, tested at their own boundary): it precomputes the DEFAULT variant
// — no harness_slug, default windows — because a snapshot keyed on
// (ws, harness_slug, key) can only ever hold that one view.
async function loadCoordTokensProducer() {
  vi.resetModules();
  vi.doMock('@papercusp/db-org', () => ({
    // route the callback with a stub tx; loaders are mocked so tx is untouched.
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn({ unsafe: async () => [] }),
  }));
  const registry = await import('./registry');
  registry.__clearDerivedReadRegistryForTest();
  await import('./producers');
  const producer = registry.listDerivedReadProducers().find((p) => p.key === 'insights.coordTokens');
  if (!producer) throw new Error('insights.coordTokens producer not registered');
  return producer;
}

describe('derived-reads producers: insights.coordTokens', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../harness-insights/load-token-rollups');
    vi.doUnmock('@papercusp/db-org');
    vi.resetModules();
  });

  it('computes the DEFAULT variant: loaders called with the ctx workspace, NO harness_slug, default windows', async () => {
    const loadModelPricingBook = vi.fn(async (_runQuery: unknown) => [{ modelId: 'opus' }]);
    const loadCoordTokenBreakdown = vi.fn(async (_opts: Record<string, unknown>) => ({
      windowMs: 604800000,
      byTrigger: [],
      triggerAttributionAvailable: false,
      byRoleClass: [{ roleClass: 'fleet', tokens: 10, costUsd: 5, runs: 2 }],
    }));
    const loadCoordPollVolume = vi.fn(async (_opts: Record<string, unknown>) => ({ windowMs: 86400000, tools: [], wakePollCalls: 7, wakePollRowSharePct: 75 }));
    vi.doMock('../harness-insights/load-token-rollups', () => ({
      loadModelPricingBook,
      loadCoordTokenBreakdown,
      loadCoordPollVolume,
    }));

    const producer = await loadCoordTokensProducer();
    expect(producer.scope).toBe('workspace');
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as Array<Record<string, unknown>>;

    // Same one-row shape the resolver's inline path produced.
    expect(out).toHaveLength(1);
    expect(out[0]!.pricingBook).toEqual([{ modelId: 'opus' }]);
    expect(out[0]!.coordBreakdown).toMatchObject({ byRoleClass: [{ roleClass: 'fleet' }] });
    expect(out[0]!.pollVolume).toMatchObject({ wakePollCalls: 7 });

    // DEFAULT variant only: workspace from ctx, NO harness_slug, windowMs unset
    // (loaders apply their own 7d/1d defaults).
    expect(loadCoordTokenBreakdown).toHaveBeenCalledTimes(1);
    const breakdownArgs = loadCoordTokenBreakdown.mock.calls[0]![0] as Record<string, unknown>;
    expect(breakdownArgs.workspace_id).toBe('ws-test');
    expect(breakdownArgs.harness_slug).toBeUndefined();
    expect(breakdownArgs.windowMs).toBeUndefined();
    const pollArgs = loadCoordPollVolume.mock.calls[0]![0] as Record<string, unknown>;
    expect(pollArgs.workspace_id).toBe('ws-test');
    expect(pollArgs.windowMs).toBeUndefined();
  });
});

// learning.improvements producer (phase2 P-003 / WI-5460 follow-up). The producer
// delegates to the SHARED compute (computeLearningImprovementsSnapshot) so the
// precomputed default and the resolver's inline non-default path can never drift;
// the only invariant to pin here is that it precomputes the DEFAULT variant (no
// state/limit/hive) and returns the shared compute's shape unchanged.
async function loadLearningImprovementsProducer() {
  vi.resetModules();
  const registry = await import('./registry');
  registry.__clearDerivedReadRegistryForTest();
  await import('./producers');
  const producer = registry.listDerivedReadProducers().find((p) => p.key === 'learning.improvements');
  if (!producer) throw new Error('learning.improvements producer not registered');
  return producer;
}

describe('derived-reads producers: learning.improvements', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../harness/improvements/learning-digest-snapshot');
    vi.resetModules();
  });

  it('computes the DEFAULT variant: shared compute called with {} (no state/limit/hive), shape passed through', async () => {
    const snapshotRow = { humanQueue: [{ id: 'EI-1' }], flow: {}, recurringSignatures: [] };
    const computeLearningImprovementsSnapshot = vi.fn(async (_a: Record<string, unknown>) => [snapshotRow]);
    vi.doMock('../harness/improvements/learning-digest-snapshot', () => ({ computeLearningImprovementsSnapshot }));

    const producer = await loadLearningImprovementsProducer();
    expect(producer.scope).toBe('workspace');
    expect(producer.ttlMs).toBe(90_000); // liveness-sensitive tier
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as unknown[];

    expect(out).toEqual([snapshotRow]);
    expect(computeLearningImprovementsSnapshot).toHaveBeenCalledTimes(1);
    expect(computeLearningImprovementsSnapshot).toHaveBeenCalledWith({});
  });
});

// coord.history producer (phase2 P-004). Precomputes ONLY the DEFAULT view —
// loadCoordHistory({}) (all sources, no filters, default limit) — and returns its
// `.items` array (the shape the sync feed carries).
async function loadCoordHistoryProducer() {
  vi.resetModules();
  const registry = await import('./registry');
  registry.__clearDerivedReadRegistryForTest();
  await import('./producers');
  const producer = registry.listDerivedReadProducers().find((p) => p.key === 'coord.history');
  if (!producer) throw new Error('coord.history producer not registered');
  return producer;
}

describe('derived-reads producers: coord.history', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../endpoint-route/routes/coord');
    vi.resetModules();
  });

  it('computes the DEFAULT view: loadCoordHistory({}) and returns its .items', async () => {
    const items = [{ source: 'message', msg_id: 'm1', ts: 't', kind: 'note', payload: {} }];
    const loadCoordHistory = vi.fn(async (_a: Record<string, unknown>) => ({ items, total: 1, truncated: false }));
    vi.doMock('../endpoint-route/routes/coord', () => ({ loadCoordHistory }));

    const producer = await loadCoordHistoryProducer();
    expect(producer.scope).toBe('workspace');
    expect(producer.ttlMs).toBe(90_000);
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as unknown[];

    expect(out).toBe(items);
    expect(loadCoordHistory).toHaveBeenCalledTimes(1);
    expect(loadCoordHistory).toHaveBeenCalledWith({}); // default view, no filters
  });
});

// P-005 producers: thin delegators to shared reads. Pin registration + delegation.
describe('derived-reads producers: P-005 (releaseReadiness, observations)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../sync-resolver/learning-release-readiness-read');
    vi.doUnmock('../sync-resolver/learning-observations-read');
    vi.resetModules();
  });

  async function loadProducer(key: string) {
    const registry = await import('./registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('./producers');
    const p = registry.listDerivedReadProducers().find((x) => x.key === key);
    if (!p) throw new Error(`${key} producer not registered`);
    return p;
  }

  it('learning.releaseReadiness wraps readReleaseReadiness() as a 1-element snapshot', async () => {
    vi.resetModules();
    const readReleaseReadiness = vi.fn(async () => ({ ready: true, bars: [] }));
    vi.doMock('../sync-resolver/learning-release-readiness-read', () => ({ readReleaseReadiness }));
    const producer = await loadProducer('learning.releaseReadiness');
    expect(producer.scope).toBe('workspace');
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as unknown[];
    expect(out).toEqual([{ ready: true, bars: [] }]);
    expect(readReleaseReadiness).toHaveBeenCalledTimes(1);
  });

  it('learning.observations delegates to computeLearningObservations({}) — the default view', async () => {
    vi.resetModules();
    const rows = [{ id: 'EI-1', body: 'x', _meta: { total: 1 } }];
    const computeLearningObservations = vi.fn(async (_a: Record<string, unknown>) => rows);
    vi.doMock('../sync-resolver/learning-observations-read', () => ({ computeLearningObservations }));
    const producer = await loadProducer('learning.observations');
    expect(producer.ttlMs).toBe(90_000);
    const out = (await producer.compute({ workspaceId: 'ws-test', harnessSlug: '' })) as unknown[];
    expect(out).toBe(rows);
    expect(computeLearningObservations).toHaveBeenCalledWith({});
  });
});

// ── plans.lint summary projection (WI-7221) ──────────────────────────────────
//
// The stored snapshot is a SUMMARY, not the full lint dump: 561,007 B / 913
// rows measured live on :3170, 2.24x the 250,000 B default sync-read ceiling.
// 355,049 B of it was `message` prose generated from 18 distinct codes.
//
// These pin the LIST half. The DETAIL half — the resolver's args-bearing branch
// returning a complete unprojected report — is pinned separately in
// sync-resolver/plans-entries.test.ts ("plans.revisions / plans.runs /
// plans.lint unwrap their fields"), so the split cannot silently collapse into
// one shape.
describe('summarizePlanLintReport (plans.lint list projection)', () => {
  it('tallies warnings by code and drops their prose, keeping the count', async () => {
    const { summarizePlanLintReport } = await import('./producers');
    const out = summarizePlanLintReport({
      slug: 'a',
      warnings: [
        { code: 'unphased_item', level: 'warning', message: 'long remediation prose ...' },
        { code: 'unphased_item', level: 'warning', message: 'more long prose ...' },
        { code: 'parse_warning', level: 'warning', message: 'yet more prose ...' },
      ],
    } as never);
    expect(out).toEqual({
      slug: 'a',
      warningCount: 3,
      warningCodes: { unphased_item: 2, parse_warning: 1 },
    });
    // Absence, not null — a `warnings` key present-but-empty would still cost
    // bytes on every row and would read as "prose available" to a consumer.
    expect('warnings' in out).toBe(false);
  });

  it('keeps errors IN FULL — they block, they are rare, a panel shows them verbatim', async () => {
    const { summarizePlanLintReport } = await import('./producers');
    const errors = [{ code: 'missing_now_section', level: 'error', message: 'No `## Now` section ...' }];
    const out = summarizePlanLintReport({ slug: 'b', errors } as never);
    // errorCount + inlined errors mirrors LintSummaryPlan (plans/lint.ts).
    expect(out).toEqual({ slug: 'b', errorCount: 1, errors });
  });

  it('omits archived/exempt/legacy when false (D-025) but round-trips a true', async () => {
    const { summarizePlanLintReport } = await import('./producers');
    const falsy = summarizePlanLintReport({
      slug: 'c',
      archived: false,
      exempt: false,
      legacy: false,
    } as never);
    // These were `false` on all 913 rows — 40,172 B to say nothing.
    expect(Object.keys(falsy)).toEqual(['slug']);
    const truthy = summarizePlanLintReport({ slug: 'd', archived: true, legacy: true } as never);
    expect(truthy).toEqual({ slug: 'd', archived: true, legacy: true });
  });

  it('a clean plan projects to slug ALONE — 246 of 913 rows are this shape', async () => {
    const { summarizePlanLintReport } = await import('./producers');
    expect(summarizePlanLintReport({ slug: 'e', errors: [], warnings: [] } as never)).toEqual({
      slug: 'e',
    });
  });

  it('the producer is registered at producerVersion 4 so the old shape is not served', async () => {
    // registry.ts:204 treats a snapshot from an older producerVersion as ABSENT
    // rather than serving a superseded shape. Bumping this is what makes the
    // projection safe to deploy against already-stored 561KB snapshots.
    vi.resetModules();
    const registry = await import('./registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('./producers');
    const producer = registry.listDerivedReadProducers().find((p) => p.key === 'plans.lint');
    expect(producer?.producerVersion).toBe(4);
  });

  it('learning.improvements is at producerVersion 3 — the WI-7279 wire narrowing needs it to take effect (WI-7275)', async () => {
    // WI-7279 narrowed the humanQueue wire shape (22 keys → 12) but left this at
    // v2, so every already-stored v2 snapshot kept passing the reader's version
    // check (registry.ts:204) and served the OLD FAT SHAPE. The fix was committed,
    // typed and tested, and still inert on the live read: measured 2026-08-03
    // 02:2xZ, the snapshot path returned 317,812 B / 22 keys while the inline
    // path — same code, same process — returned 223,159 B / 11.
    //
    // Restarting the producer host does NOT substitute for this. THREE hosts write
    // this row (:3170, :3070 release, bg-host) and :3070 runs release code, so at
    // EQUAL versions the downgrade guard (registry.ts:380) permits the stale writer
    // to clobber the slim row back indefinitely. Only a version bump makes a shape
    // change self-enforcing.
    vi.resetModules();
    const registry = await import('./registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('./producers');
    const producer = registry
      .listDerivedReadProducers()
      .find((p) => p.key === 'learning.improvements');
    expect(producer?.producerVersion).toBe(3);
  });

  it('coord.history is at producerVersion 2 — the payload de-duplication needs it to take effect (WI-7295)', async () => {
    // toHistoryItem used to set `payload: e`, the WHOLE envelope the row's own
    // ts/msg_id/kind/from/to/plan_slug/harness_slug were projected FROM — so every
    // row shipped those 7 values twice. Measured live 2026-08-03 on the default
    // 200-row view: 42,328 redundant bytes, 16.2% of a 261,140 B read whose budget
    // is 250,000. Same trap as learning.improvements above: without this bump the
    // already-stored v1 snapshots keep passing the reader's version check and serve
    // the old fat rows, so the cut ships inert.
    vi.resetModules();
    const registry = await import('./registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('./producers');
    const producer = registry.listDerivedReadProducers().find((p) => p.key === 'coord.history');
    expect(producer?.producerVersion).toBe(2);
  });
});
