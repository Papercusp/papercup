import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Learning tab's improvements feed reads the `learning.improvements` named
 * query (operator-learning-tab-2026-06-09 P-002). Since phase2 P-003 the digest +
 * flow computation lives in the SHARED `computeLearningImprovementsSnapshot`
 * (harness/improvements/learning-digest-snapshot) — the precomputed default
 * variant and the resolver's live inline non-default path both call it, so the
 * compute logic is pinned HERE against that function directly (mirroring how the
 * rubrics.list precompute migration moved its rollup test to producers.test.ts).
 * The resolver's OWN default→snapshot / non-default→inline / recordQueueExposure
 * gate is pinned separately in sync-resolver/learning-improvements-queries.test.ts.
 *
 * Here we assert (1) the query is still registered in the v2 resolver — a missing
 * registration is the failure mode that would silently 404 the tab — and (2) the
 * P-041 flow extension: the row is the digest PLUS a `flow` block whose recurrence
 * count is REUSED from the digest's recurringSignatures (never re-derived) and
 * whose watchdog half degrades gracefully when the tick read fails, plus the P-040
 * per-Hive scope resolution.
 */

const readImprovementItems = vi.fn();
// WI-39675: the compute now ALSO reads the true corpus total alongside the
// (windowed) items, so this mock must export `countImprovementItems` too. It is
// mocked as its own fn rather than passed through to the real one because the
// point of the pairing is that BOTH calls take the SAME filter — asserting that
// needs the count's arguments, not just its result.
const countImprovementItems = vi.fn();
vi.mock('../harness/improvements/read-items', () => ({
  readImprovementItems: (...a: unknown[]) => readImprovementItems(...a),
  countImprovementItems: (...a: unknown[]) => countImprovementItems(...a),
  IMPROVEMENT_TOPIC: 'papercusp-improvement',
}));

const readWatchdogFlowTicks = vi.fn();
vi.mock('../harness/improvements/flow-metrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../harness/improvements/flow-metrics')>();
  return { ...real, readWatchdogFlowTicks: (...a: unknown[]) => readWatchdogFlowTicks(...a) };
});

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// EI-18138040328678826: computeLearningImprovementsSnapshot ALSO reads the owner
// full-autonomy grant (readOwnerFullAutonomyGrant, Phase 2) and the dispatch-ledger
// rollup (readRecentDispatches, P-010/B-04) — both added to the implementation
// AFTER this test file's mock set was written, and both LEFT UNMOCKED. Neither
// touches PG/PostHog directly in a unit run (they're wrapped in try/catch here and
// fall back), but that means this "unit" test's outcome silently depended on
// whatever REAL flag-override / DB state happened to be reachable in the process —
// order/isolation-dependent by construction (flaked under the full `test:affected`
// run, 7/7 green in isolation: getFlag() falls through to a module-level
// `overrides` singleton in `@papercusp/flags/test` that OTHER unit test files set
// via setFlagOverridesForTest and — for at least one file, since fixed — never
// reset, and that singleton is a real external-package module instance NOT reset
// between test files sharing a vitest forked worker). Mock both explicitly, like
// every other data source here, so this test can never again depend on real
// process-global state.
const readOwnerFullAutonomyGrant = vi.fn();
vi.mock('../harness/improvements/full-autonomy-grant', () => ({
  readOwnerFullAutonomyGrant: (...a: unknown[]) => readOwnerFullAutonomyGrant(...a),
}));

const readRecentDispatches = vi.fn();
vi.mock('../harness/improvements/dispatch-ledger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../harness/improvements/dispatch-ledger')>();
  return { ...real, readRecentDispatches: (...a: unknown[]) => readRecentDispatches(...a) };
});

// P-040: the per-Hive lens resolves the hive → its member-harness scope set via
// the registry. Keep hiveMemberHarnessScopes REAL (pure) over a mocked registry.
const loadHarnessRegistry = vi.fn();
vi.mock('../harness-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../harness-registry')>();
  return { ...real, loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a) };
});

import { knownQueryNamesV2 } from './index';
import {
  computeLearningImprovementsSnapshot,
  HUMAN_QUEUE_WIRE_FIELDS,
} from '../harness/improvements/learning-digest-snapshot';
import { assertShapeMatchesRecordedVersion } from '../derived-reads/shape-fingerprint';
import { __clearDerivedReadRegistryForTest, listDerivedReadProducers } from '../derived-reads/registry';

beforeEach(() => {
  readImprovementItems.mockReset();
  // Default to the DEGRADED reading (`undefined`) — the exact value the
  // implementation's own `.catch(() => undefined)` produces when the count fails,
  // which makes `digest.total` fall back to candidates.length. That keeps every
  // pre-WI-39675 assertion in this file testing the contract it was written for;
  // the tests that care about the corpus total set a number explicitly.
  countImprovementItems.mockReset().mockResolvedValue(undefined);
  readWatchdogFlowTicks.mockReset();
  loadHarnessRegistry.mockReset();
  readOwnerFullAutonomyGrant.mockReset().mockResolvedValue(false);
  readRecentDispatches.mockReset().mockResolvedValue([]);
});

describe('learning.* resolver registration', () => {
  it('registers learning.improvements + learning.gym + learning.apiary in the v2 named-query resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.improvements');
    expect(names).toContain('learning.gym');
    expect(names).toContain('learning.apiary');
  });
});

describe('learning.improvements — digest + flow row (P-041)', () => {
  // Two same-signature items (one open, one resolved this week) → one recurring
  // signature in the digest, 1 capture + 1 resolve inside the 7d flow window.
  const recentIso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const items = [
    { id: 'EI-1', kind: 'bug', scope: 'operator', title: 'spawn tree leaks frames', state: 'open', createdAt: recentIso(2) },
    { id: 'EI-2', kind: 'bug', scope: 'operator', title: 'spawn tree leaks frames', state: 'resolved', createdAt: recentIso(20), updatedAt: recentIso(1) },
  ];

  it('returns [digest & { flow }] with recurrence reused from digest.recurringSignatures', async () => {
    readImprovementItems.mockResolvedValue(items);
    readWatchdogFlowTicks.mockResolvedValue([{ tickAtMs: Date.now() - 10 * 60_000, capturedCount: 2 }]);

    const rows = await computeLearningImprovementsSnapshot({});
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // The digest half is intact (the tool-shared shape).
    expect(row.total).toBe(2);
    expect(row.open).toBe(1);
    expect(row.recurringSignatures).toHaveLength(1);

    // The flow half: windows + the recurrence pass-through.
    expect(row.flow.captured7d).toBe(1);
    expect(row.flow.resolved7d).toBe(1);
    expect(row.flow.net7d).toBe(0);
    expect(row.flow.medianOpenAgeDays).toBeCloseTo(2, 0);
    expect(row.flow.recurringSignatureCount).toBe(row.recurringSignatures.length);
    expect(row.flow.watchdog.ticks24h).toBe(1);
    expect(row.flow.watchdog.captured24h).toBe(2);
    expect(row.flow.watchdog.lastTickAt).toBeTruthy();
    expect(readWatchdogFlowTicks).toHaveBeenCalledWith('ws-test');
  });

  it('strips the per-item rank/impact ranking metadata off the wire (WI-5412 slimming)', async () => {
    // An open needs-human item lands in humanQueue, where the ranker attaches
    // rank + impact — the resolver must drop both from the wire (the UI never
    // renders them; the improvements:digest TOOL keeps the full breakdown).
    readImprovementItems.mockResolvedValue([
      { id: 'EI-9', kind: 'bug', scope: 'operator', title: 'needs a human', state: 'open', createdAt: recentIso(1), needsHuman: true },
    ]);
    readWatchdogFlowTicks.mockResolvedValue([]);
    // No cast: the compute now returns the precise WIRE type (WI-7279), which is
    // deliberately NOT assignable to ImprovementDigest — humanQueue is the
    // narrowed SlimHumanQueueItem. Casting it back would defeat the point.
    const rows = await computeLearningImprovementsSnapshot({});
    expect(rows[0].humanQueue.length).toBeGreaterThan(0);
    for (const item of rows[0].humanQueue) {
      expect(item).not.toHaveProperty('rank');
      expect(item).not.toHaveProperty('impact');
    }
  });

  // ── WI-7279: the slimming is an ALLOWLIST, and BOTH halves are pinned ────────
  //
  // The test above pins only that `rank`/`impact` are GONE. That is a denylist
  // assertion, and it is exactly why the payload silently re-inflated to 318,082B
  // (695 B/row over 453 rows, against the 250,000 default ceiling): ten fields
  // added to ScoredItem after WI-5412 sailed onto the wire without ever tripping
  // it. A denylist test cannot fail on a field nobody thought to name.
  //
  // So pin the CONTRACT, not a sample: the exported field list IS the wire shape,
  // and widening it must require editing this assertion — i.e. a deliberate act
  // with a named consumer, not a silent upstream side effect.
  it('pins the exact humanQueue wire field list — adding a field must be deliberate (WI-7279)', () => {
    expect([...HUMAN_QUEUE_WIRE_FIELDS]).toEqual([
      'id',
      'kind',
      'title',
      'scope',
      'severity',
      'state',
      'assignee',
      'score',
      'ageDays',
      'tierReason',
      'ideaType',
      'source',
    ]);
    // The COUNT pinned separately: a bare re-add that happens to keep the list
    // sorted would otherwise read as fine on a skimmed diff.
    expect(HUMAN_QUEUE_WIRE_FIELDS).toHaveLength(12);
  });

  it('serves ONLY allowlisted humanQueue fields, and omits null ones (WI-7279)', async () => {
    readImprovementItems.mockResolvedValue([
      {
        id: 'EI-9',
        kind: 'bug',
        scope: 'operator',
        title: 'needs a human',
        state: 'open',
        createdAt: recentIso(1),
        needsHuman: true,
        // The measured re-inflation set — every one of these was live on the wire
        // at 2026-08-03 and read by NO consumer. `assignee: null` additionally
        // covers the D-025 null-omit (it was null on 452 of 453 real rows).
        assignee: null,
        assignedAt: null,
        updatedAt: recentIso(1),
        attempts: 0,
        tier: 'human',
        ideaLifecycleState: 'triaged',
        triageDecision: 'gate',
        workItemOrigin: 'remote',
      },
    ]);
    readWatchdogFlowTicks.mockResolvedValue([]);
    const rows = await computeLearningImprovementsSnapshot({});
    expect(rows[0].humanQueue.length).toBeGreaterThan(0);

    const allowed = new Set<string>(HUMAN_QUEUE_WIRE_FIELDS);
    for (const item of rows[0].humanQueue) {
      // Half 1 — nothing outside the allowlist reaches the client. This is the
      // assertion the old denylist test could not make.
      for (const key of Object.keys(item)) expect(allowed).toContain(key);
      // Half 2 — assert KEY ABSENCE, not toBeNull(): an explicitly-null key still
      // costs bytes on the wire, so `toBeNull()` would pass on the regression.
      for (const dropped of [
        'tier',
        'attempts',
        'deferral',
        'updatedAt',
        'assignedAt',
        'triageDecision',
        'ideaLifecycleState',
        'bettable',
        'ideation',
        'workItemOrigin',
        'rank',
        'impact',
      ]) {
        expect(item).not.toHaveProperty(dropped);
      }
      // The null-omit: `assignee` was supplied as null and must not be serialized.
      expect(item).not.toHaveProperty('assignee');
      // ...while a genuinely-read field survives.
      expect(item.id).toBe('EI-9');
      expect(item.title).toBe('needs a human');
    }
  });

  it('degrades to an empty watchdog block when the tick read fails (no 500 for the tab)', async () => {
    readImprovementItems.mockResolvedValue(items);
    readWatchdogFlowTicks.mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await computeLearningImprovementsSnapshot({});
      expect(rows[0].flow.watchdog).toEqual({ lastTickAt: null, ticks24h: 0, captured24h: 0 });
      expect(rows[0].flow.captured7d).toBe(1); // the item half still computed
    } finally {
      warn.mockRestore();
    }
  });

  // ── WI-7289 shape guard ──────────────────────────────────────────────────
  //
  // The wire-field-list pin above (WI-7279) protects HUMAN_QUEUE_WIRE_FIELDS
  // from silent drift, but nothing tied that list — or the digest/flow shape
  // wrapping it — to the `learning.improvements` producer's registered
  // `producerVersion` in producers.ts. That is exactly how this shipped
  // inert TWICE (v1->v2 D-002, v2->v3 WI-7279): the shape changed, the tests
  // above still passed (they pin the CODE's wire contract, not the
  // registry's version number), and a stored snapshot at the OLD version kept
  // serving the OLD shape forever (registry.ts:204/380).
  //
  // This ties them together: fingerprint a REAL sample (computed through the
  // actual narrowing logic above, not a stand-in mock) and require it to
  // match the shape recorded for the producer's LIVE registered version. If
  // the shape changes without a version bump, the recorded entry for the
  // (unchanged) version stops matching and this fails. If the version bumps
  // without anyone recording what the new shape is, there's no entry for it
  // and this fails too — see shape-fingerprint.ts's module doc.
  it('shape-guard: the real payload shape matches the shape recorded for the LIVE registered producerVersion (WI-7289)', async () => {
    readImprovementItems.mockResolvedValue([
      {
        id: 'EI-9',
        kind: 'bug',
        scope: 'operator',
        title: 'needs a human',
        state: 'open',
        createdAt: recentIso(1),
        needsHuman: true,
        assignee: null, // exercises the D-025 null-omit path — see shape-fingerprint.test.ts
        assignedAt: null,
        updatedAt: recentIso(1),
        attempts: 0,
        tier: 'human',
        ideaLifecycleState: 'triaged',
        triageDecision: 'gate',
        workItemOrigin: 'remote',
      },
    ]);
    readWatchdogFlowTicks.mockResolvedValue([{ tickAtMs: Date.now() - 10 * 60_000, capturedCount: 2 }]);
    const rows = await computeLearningImprovementsSnapshot({});

    __clearDerivedReadRegistryForTest();
    await import('../derived-reads/producers');
    const producer = listDerivedReadProducers().find((p) => p.key === 'learning.improvements');
    if (!producer) throw new Error('learning.improvements producer not registered');

    assertShapeMatchesRecordedVersion({
      key: 'learning.improvements',
      producerVersion: producer.producerVersion,
      sample: rows[0],
      expectedByVersion: {
        // Captured from a real computeLearningImprovementsSnapshot() call against
        // the fixture above (not hand-typed) — see shape-fingerprint.ts's module
        // doc for how to regenerate this after a DELIBERATE shape change.
        3: 'obj{autoEligible:arr<empty>,byKind:obj{bug:number},bySeverity:obj{},byState:obj{open:number},diagnosisClusters:obj{clusters:arr<empty>,considered:number,ritualExcluded:number,unshaped:number},flow:obj{captured7d:number,dispatch:obj{fireFailed:number,fired7d:number,firing:number,fixed7d:number,inProgress:number,lastDispatchAt:null,lastOutcomeAt:null,orphaned:number,overdue:number,resolved:obj{couldNotFix:number,fixed:number,needsHuman:number},total:number},medianOpenAgeDays:number,net7d:number,recurringSignatureCount:number,resolved7d:number,watchdog:obj{captured24h:number,lastTickAt:string,ticks24h:number}},generatedAt:string,headline:string,humanQueue:arr<obj{ageDays:number,id:string,ideaType:string,kind:string,scope:string,score:number,state:string,tierReason:string,title:string}>,likelyDuplicates:arr<empty>,likelyDuplicatesScope:obj{consideredCount:number,corpusTotal:number,nearDupConsidered:number,nearDupPass:string,windowed:boolean},open:number,recurringSignatures:arr<empty>,returned:number,total:number,windowed:boolean}',
      },
    });
  });
});

/**
 * WI-39675: `digest.total` is the TRUE corpus total, not the size of the window
 * that was read.
 *
 * The defect this pins is a repeat, not a novelty: EI-18790490225750395 already
 * fixed exactly this on the `improvements:digest` AGENT-TOOL path, and the fix was
 * never propagated here — so the Learning tab's "From the loop N" silently
 * saturated at the default 500-row read window while the agent-facing tool
 * reported the truth. A windowed measurement rendered as a population total is
 * indistinguishable from a real count at the read site, which is what makes it
 * worth a guard rather than a comment.
 */
describe('learning.improvements — digest.total is the corpus, not the window (WI-39675)', () => {
  const windowRow = (id: string) => ({
    id,
    kind: 'bug',
    scope: 'operator',
    title: `row ${id}`,
    state: 'open',
    createdAt: new Date().toISOString(),
  });

  it('reports the COUNTED corpus total while returning only the windowed rows', async () => {
    // The shape of the real bug: the read is capped at a window (3 rows here,
    // 500 in production) while the corpus behind it is far larger.
    readImprovementItems.mockResolvedValue([windowRow('EI-1'), windowRow('EI-2'), windowRow('EI-3')]);
    countImprovementItems.mockResolvedValue(8202);
    readWatchdogFlowTicks.mockResolvedValue([]);

    const row = (await computeLearningImprovementsSnapshot({}))[0];

    expect(row.total).toBe(8202);
    expect(row.returned).toBe(3);
    // `windowed` is the flag the UI needs to say "3 of 8202" honestly rather than
    // implying it is showing everything.
    expect(row.windowed).toBe(true);
    // The regression this file is guarding: total tracking the window size.
    expect(row.total).not.toBe(3);
  });

  it('counts over the SAME filter the read used — a count over a different population is the same lie in a new place', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    countImprovementItems.mockResolvedValue(42);
    readWatchdogFlowTicks.mockResolvedValue([]);

    await computeLearningImprovementsSnapshot({ state: 'open', limit: 500 });

    // Both sides of the pairing must see one identical filter object; a count
    // taken over a WIDER filter than the list (e.g. dropping the loop-provenance
    // scope) would report a plausible-looking total for a different population.
    expect(countImprovementItems).toHaveBeenCalledTimes(1);
    expect(countImprovementItems.mock.calls[0][0]).toEqual(readImprovementItems.mock.calls[0][0]);
    // And that shared filter really does carry the tab's default provenance scope.
    expect(countImprovementItems.mock.calls[0][0]).toMatchObject({ state: 'open', loopOutputOnly: true });
  });

  it('degrades to the returned-row count when the corpus COUNT fails — never sinks the tab', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1'), windowRow('EI-2')]);
    countImprovementItems.mockRejectedValue(new Error('count query timed out'));
    readWatchdogFlowTicks.mockResolvedValue([]);

    const rows = await computeLearningImprovementsSnapshot({});

    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(2);
    expect(rows[0].windowed).toBe(false);
  });
});

describe('learning.improvements — per-Hive lens (P-040)', () => {
  beforeEach(() => {
    readImprovementItems.mockResolvedValue([]);
    readWatchdogFlowTicks.mockResolvedValue([]);
  });

  it('resolves the hive → its member-harness scope set and passes harnessScopes to readImprovementItems', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        { slug: 'my-hive' },
        { slug: 'member-a', hive_slug: 'my-hive' },
        { slug: 'elsewhere', hive_slug: 'other-hive' },
      ],
    });
    await computeLearningImprovementsSnapshot({ hive: 'my-hive' });
    expect(loadHarnessRegistry).toHaveBeenCalled();
    const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
    expect(passed.harnessScopes?.sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('omits harnessScopes entirely when no hive is given (workspace-wide feed)', async () => {
    await computeLearningImprovementsSnapshot({});
    const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
    expect(passed.harnessScopes).toBeUndefined();
    expect(loadHarnessRegistry).not.toHaveBeenCalled();
  });

  it('degrades to the unfiltered feed (no 500) when the registry read fails', async () => {
    loadHarnessRegistry.mockRejectedValue(new Error('registry down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await computeLearningImprovementsSnapshot({ hive: 'my-hive' });
      expect(Array.isArray(rows)).toBe(true);
      const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
      expect(passed.harnessScopes).toBeUndefined(); // fell back to workspace-wide
    } finally {
      warn.mockRestore();
    }
  });
});
