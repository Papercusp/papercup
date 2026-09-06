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
// WI-471938: the same pairing again, one dimension over — the compute reads the corpus
// SOURCE VOCABULARY alongside the corpus total, so this explicit factory has to export it
// too or the compute destructures `undefined` and every test here dies on a TypeError with
// nothing to do with what it was asserting.
const improvementSourceCounts = vi.fn();
const projectImprovementItemsForBoundedRead = vi.fn();
vi.mock('../harness/improvements/read-items', () => ({
  readImprovementItems: (...a: unknown[]) => readImprovementItems(...a),
  countImprovementItems: (...a: unknown[]) => countImprovementItems(...a),
  improvementSourceCounts: (...a: unknown[]) => improvementSourceCounts(...a),
  projectImprovementItemsForBoundedRead: (...a: unknown[]) => projectImprovementItemsForBoundedRead(...a),
  IMPROVEMENT_TOPIC: 'papercusp-improvement',
}));

const readLearningImproveRoutedRows = vi.fn();
vi.mock('./learning-scout-read', async (importOriginal) => {
  const real = await importOriginal<typeof import('./learning-scout-read')>();
  return { ...real, readLearningImproveRoutedRows: (...a: unknown[]) => readLearningImproveRoutedRows(...a) };
});

// The learned ranker features have graduated to default-ON, but this suite
// verifies the resolver's digest/wire contract rather than their PG-backed
// models. Pin the optional features OFF and give the always-on blocking-impact
// feature a deterministic zero-edge view so this stays a hermetic unit test.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock('../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../issues-engineer')>()),
  issueLinkCounts: vi.fn(async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, { blocksOut: 0, inboundRefs: 0 }])),
  ),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});

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
  tierReasonOf,
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
  // Same rationale as the count above: default to the DEGRADED reading so every
  // pre-WI-471938 assertion keeps testing its own contract, and the tests that care
  // about the source vocabulary set it explicitly.
  improvementSourceCounts.mockReset().mockResolvedValue(undefined);
  projectImprovementItemsForBoundedRead.mockReset().mockImplementation(
    async (_opts: unknown, projection: { project: (items: unknown[]) => Promise<unknown[]> | unknown[] }) =>
      projection.project([]),
  );
  readLearningImproveRoutedRows.mockReset().mockResolvedValue([]);
  readWatchdogFlowTicks.mockReset();
  loadHarnessRegistry.mockReset();
  readOwnerFullAutonomyGrant.mockReset().mockResolvedValue(false);
  readRecentDispatches.mockReset().mockResolvedValue([]);
});

describe('learning.* resolver registration', () => {
  it('registers learning.improvements + learning.gym + learning.apiary in the v2 named-query resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.improvements');
    expect(names).toContain('learning.improvements.summary');
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
    expect(row.census.total).toBe(2);
    expect(row.window.open).toBe(1);
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
      'ideaType',
      'source',
    ]);
    // The COUNT pinned separately: a bare re-add that happens to keep the list
    // sorted would otherwise read as fine on a skimmed diff.
    expect(HUMAN_QUEUE_WIRE_FIELDS).toHaveLength(11);
    // `tierReason` LEFT this list in WI-39773 (D-008) but did NOT leave the wire —
    // it ships interned as `trc` + a legend, guarded below. Pinned as an explicit
    // absence so a future re-add has to confront the interning rather than
    // silently restoring 30.6% of the payload alongside it.
    expect([...HUMAN_QUEUE_WIRE_FIELDS]).not.toContain('tierReason');
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

    // `trc` (the interned tierReason, WI-39773/D-008) is a wire key that is
    // deliberately NOT in HUMAN_QUEUE_WIRE_FIELDS — that list is the projection
    // source, and `trc` is synthesized beside it. Named here rather than folded
    // into the list so the pin above keeps meaning "these are projected verbatim".
    const allowed = new Set<string>([...HUMAN_QUEUE_WIRE_FIELDS, 'trc']);
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

  // ── tierReason interning (WI-39773 / plan …-2026-08-17 D-008) ───────────────
  //
  // Measured live 2026-08-18: `tierReason` was 83,526 B of a 272,705 B humanQueue
  // (30.6%, 167 B/row) across only SIX distinct sentences on 500/500 rows. It now
  // ships as a `trc` code into a per-payload `tierReasonLegend`.
  //
  // The load-bearing assertion here is DEDUPE, not round-trip. A legend that
  // emitted one entry per row would round-trip perfectly and save nothing — it
  // would be the same payload with an extra array — so a round-trip-only test
  // would pass on an encoding that does not work. Both are asserted below.
  it('interns tierReason: rows sharing a reason share ONE legend entry (WI-39773/D-008)', async () => {
    // Three items that must land on the SAME tier reason (explicitly needs-human)
    // and one that must land on a DIFFERENT one (kind=feature is not auto-eligible).
    readImprovementItems.mockResolvedValue([
      ...['EI-1', 'EI-2', 'EI-3'].map((id) => ({
        id,
        kind: 'bug',
        scope: 'operator',
        title: `human ${id}`,
        state: 'open',
        createdAt: recentIso(1),
        needsHuman: true,
      })),
      {
        id: 'EI-4',
        kind: 'feature',
        scope: 'operator',
        title: 'a feature',
        state: 'open',
        createdAt: recentIso(1),
      },
    ]);
    readWatchdogFlowTicks.mockResolvedValue([]);
    const [row] = await computeLearningImprovementsSnapshot({});
    const queue = row.humanQueue;
    expect(queue).toHaveLength(4);

    // 1. The fat string is GONE from every row — assert key ABSENCE, since an
    //    explicitly-undefined key would still cost bytes.
    for (const item of queue) expect(item).not.toHaveProperty('tierReason');

    // 2. Every row resolves to a non-empty sentence through the legend. This is
    //    the round-trip half: interning must not lose the text, or the owner's
    //    quick search silently matches less (no error, just fewer hits).
    for (const item of queue) {
      expect(tierReasonOf(row.tierReasonLegend, item)).not.toBe('');
    }

    // 3. THE ONE THAT BITES — dedupe. Four rows, exactly two distinct reasons, so
    //    the legend must hold 2 entries, not 4. The three needs-human rows must
    //    carry the SAME code and the feature row a DIFFERENT one. Asserted on
    //    codes rather than on the policy's prose so a reworded reason string does
    //    not fail this test for the wrong reason.
    expect(row.tierReasonLegend).toHaveLength(2);
    expect(new Set(row.tierReasonLegend).size).toBe(2); // entries are distinct
    const codeOf = (id: string) => queue.find((i) => i.id === id)?.trc;
    expect(codeOf('EI-1')).toBe(codeOf('EI-2'));
    expect(codeOf('EI-2')).toBe(codeOf('EI-3'));
    expect(codeOf('EI-4')).not.toBe(codeOf('EI-1'));

    // 4. Codes index the legend they shipped with.
    for (const item of queue) {
      expect(item.trc).toBeGreaterThanOrEqual(0);
      expect(item.trc).toBeLessThan(row.tierReasonLegend.length);
    }
  });

  it('omits trc entirely when an item has no tier reason (WI-39773/D-008)', () => {
    // A legend entry for '' would put an empty string in every consumer's search
    // haystack and cost a code on rows that carry nothing.
    expect(tierReasonOf([], null)).toBe('');
    expect(tierReasonOf(undefined, { trc: 0 })).toBe('');
    // An out-of-range code degrades to '' rather than `undefined` — a caller
    // concatenating it into a haystack would otherwise inject the literal
    // "undefined" and make a search for "undef" match every row.
    expect(tierReasonOf(['only-one'], { trc: 7 })).toBe('');
    expect(tierReasonOf(['a', 'b'], { trc: 1 })).toBe('b');
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
    // WI-471938: the sample has to carry the SUCCESSFUL corpus-vocabulary read, because
    // that is the shape production serves. Leaving the suite-wide degraded default here
    // would omit `sourceOptions` from the fingerprint and let the real shape drift past
    // this pin — the exact silent-inert failure the version counter exists to stop.
    improvementSourceCounts.mockResolvedValue({ Scout: 2, system: 1 });
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
        // v4 (WI-39773 / D-008): `tierReason:string` LEAVES the humanQueue row and
        // is replaced by `trc:number` + a top-level `tierReasonLegend:arr<string>`.
        // Those two deltas are the whole diff from v3 — captured from a real call,
        // not hand-typed.
        4: 'obj{autoEligible:arr<empty>,byKind:obj{bug:number},bySeverity:obj{},byState:obj{open:number},diagnosisClusters:obj{clusters:arr<empty>,considered:number,ritualExcluded:number,unshaped:number},flow:obj{captured7d:number,dispatch:obj{fireFailed:number,fired7d:number,firing:number,fixed7d:number,inProgress:number,lastDispatchAt:null,lastOutcomeAt:null,orphaned:number,overdue:number,resolved:obj{couldNotFix:number,fixed:number,needsHuman:number},total:number},medianOpenAgeDays:number,net7d:number,recurringSignatureCount:number,resolved7d:number,watchdog:obj{captured24h:number,lastTickAt:string,ticks24h:number}},generatedAt:string,headline:string,humanQueue:arr<obj{ageDays:number,id:string,ideaType:string,kind:string,scope:string,score:number,state:string,title:string,trc:number}>,likelyDuplicates:arr<empty>,likelyDuplicatesScope:obj{consideredCount:number,corpusTotal:number,nearDupConsidered:number,nearDupPass:string,windowed:boolean},open:number,recurringSignatures:arr<empty>,returned:number,tierReasonLegend:arr<string>,total:number,windowed:boolean}',
        // v5 (WI-471938): the ONE delta from v4 is a top-level
        // `sourceOptions:arr<obj{count:number,value:string}>` — the corpus-wide "Filed by"
        // vocabulary, which the chips previously derived from the windowed rows. The bump
        // is not cosmetic: the client falls back to that window-derived set when the field
        // is ABSENT, so a stored v4 row would keep serving the defect this change removes.
        5: 'obj{autoEligible:arr<empty>,byKind:obj{bug:number},bySeverity:obj{},byState:obj{open:number},diagnosisClusters:obj{clusters:arr<empty>,considered:number,ritualExcluded:number,unshaped:number},flow:obj{captured7d:number,dispatch:obj{fireFailed:number,fired7d:number,firing:number,fixed7d:number,inProgress:number,lastDispatchAt:null,lastOutcomeAt:null,orphaned:number,overdue:number,resolved:obj{couldNotFix:number,fixed:number,needsHuman:number},total:number},medianOpenAgeDays:number,net7d:number,recurringSignatureCount:number,resolved7d:number,watchdog:obj{captured24h:number,lastTickAt:string,ticks24h:number}},generatedAt:string,headline:string,humanQueue:arr<obj{ageDays:number,id:string,ideaType:string,kind:string,scope:string,score:number,state:string,title:string,trc:number}>,likelyDuplicates:arr<empty>,likelyDuplicatesScope:obj{consideredCount:number,corpusTotal:number,nearDupConsidered:number,nearDupPass:string,windowed:boolean},open:number,recurringSignatures:arr<empty>,returned:number,sourceOptions:arr<obj{count:number,value:string}>,tierReasonLegend:arr<string>,total:number,windowed:boolean}',
        // v6: population truth and bounded-window rollups are explicitly separated
        // into `census` and `window`. This is a wire-shape change, not a rename a v5
        // snapshot can safely coast through.
        6: 'obj{autoEligible:arr<empty>,census:obj{total:number},diagnosisClusters:obj{clusters:arr<empty>,considered:number,ritualExcluded:number,unshaped:number},flow:obj{captured7d:number,dispatch:obj{fireFailed:number,fired7d:number,firing:number,fixed7d:number,inProgress:number,lastDispatchAt:null,lastOutcomeAt:null,orphaned:number,overdue:number,resolved:obj{couldNotFix:number,fixed:number,needsHuman:number},total:number},medianOpenAgeDays:number,net7d:number,recurringSignatureCount:number,resolved7d:number,watchdog:obj{captured24h:number,lastTickAt:string,ticks24h:number}},generatedAt:string,headline:string,humanQueue:arr<obj{ageDays:number,id:string,ideaType:string,kind:string,scope:string,score:number,state:string,title:string,trc:number}>,likelyDuplicates:arr<empty>,likelyDuplicatesScope:obj{consideredCount:number,corpusTotal:number,nearDupConsidered:number,nearDupPass:string,windowed:boolean},recurringSignatures:arr<empty>,sourceOptions:arr<obj{count:number,value:string}>,tierReasonLegend:arr<string>,window:obj{byKind:obj{bug:number},bySeverity:obj{},byState:obj{open:number},examined:number,open:number,windowed:boolean}}',
      },
    });
  });
});

/**
 * WI-39675: `digest.census.total` is the TRUE corpus total, not the size of the window
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
describe('learning.improvements — digest.census.total is the corpus, not the window (WI-39675)', () => {
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

    expect(row.census.total).toBe(8202);
    expect(row.window.examined).toBe(3);
    // `window.windowed` is the flag the UI needs to say "3 of 8202" honestly rather than
    // implying it is showing everything.
    expect(row.window.windowed).toBe(true);
    // The regression this file is guarding: total tracking the window size.
    expect(row.census.total).not.toBe(3);
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

  it('classifies the scoped corpus before applying bounded view predicates', async () => {
    const filtered = {
      ...windowRow('EI-filtered'),
      title: 'timeout in the worker',
      severity: 'critical',
      scope: 'harness:foo',
    };
    projectImprovementItemsForBoundedRead.mockImplementation(
      async (_opts: unknown, projection: { project: (items: unknown[]) => Promise<unknown[]> | unknown[] }) =>
        projection.project([filtered]),
    );
    readWatchdogFlowTicks.mockResolvedValue([]);
    const args = {
      q: 'timeout',
      kinds: ['bug'] as const,
      severities: ['critical'] as const,
      scopes: ['harness:foo'],
    };

    const rows = await computeLearningImprovementsSnapshot(args);

    // q/kind/severity/scope stay OUT of the store read: tierReason and the
    // merged idea half do not exist until classification/join, so applying any
    // of them before that stage would recreate the beyond-page blind spot.
    expect(projectImprovementItemsForBoundedRead.mock.calls[0][0]).toEqual({ loopOutputOnly: true });
    expect(rows[0].window.examined).toBe(1);
    expect(rows[0].census.total).toBe(1);
  });

  it('degrades to the returned-row count when the corpus COUNT fails — never sinks the tab', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1'), windowRow('EI-2')]);
    countImprovementItems.mockRejectedValue(new Error('count query timed out'));
    readWatchdogFlowTicks.mockResolvedValue([]);

    const rows = await computeLearningImprovementsSnapshot({});

    expect(rows).toHaveLength(1);
    expect(rows[0].census.total).toBe(2);
    expect(rows[0].window.windowed).toBe(false);
  });

  // ── WI-471938: the corpus SOURCE VOCABULARY, the same bug one dimension over ──
  //
  // `total` was the window size wearing the corpus's name; the tab's "Filed by" chips had
  // the identical defect in the option set — they were derived from the projected rows, so
  // a source living only past the window offered no chip at all. Measured live 2026-08-28:
  // `system` had 15 corpus rows and 0 in the newest-500 window.

  it('carries the CORPUS source vocabulary, not the sources present in the windowed rows', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    improvementSourceCounts.mockResolvedValue({ Scout: 1007, system: 15 });
    readWatchdogFlowTicks.mockResolvedValue([]);

    const row = (await computeLearningImprovementsSnapshot({}))[0];

    // `system` is in the answer even though no returned row carries it — that IS the fix.
    expect(row.sourceOptions).toEqual([
      { value: 'Scout', count: 1007 },
      { value: 'system', count: 15 },
    ]);
  });

  it('reads the vocabulary over the SAME filter as the rows and the count', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    improvementSourceCounts.mockResolvedValue({ Scout: 3 });
    countImprovementItems.mockResolvedValue(9);
    readWatchdogFlowTicks.mockResolvedValue([]);

    await computeLearningImprovementsSnapshot({ state: 'open', limit: 500 });

    // A vocabulary read over a WIDER population than the list would offer chips that
    // yield nothing — the same lie as a total over the wrong population, pointed the
    // other way.
    expect(improvementSourceCounts).toHaveBeenCalledTimes(1);
    expect(improvementSourceCounts.mock.calls[0][0]).toEqual(readImprovementItems.mock.calls[0][0]);
    expect(improvementSourceCounts.mock.calls[0][0]).toMatchObject({ loopOutputOnly: true });
  });

  it('drops the unfiled bucket and sorts by value — a chip strip needs options, in a stable order', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    // The '' key is how the SQL layer reports rows with no sourceRole; it keeps that
    // histogram totalling countIssues(), but "unfiled" is not a selectable chip.
    improvementSourceCounts.mockResolvedValue({ system: 15, '': 1048, Scout: 1007 });
    readWatchdogFlowTicks.mockResolvedValue([]);

    const row = (await computeLearningImprovementsSnapshot({}))[0];

    expect(row.sourceOptions?.map((o) => o.value)).toEqual(['Scout', 'system']);
  });

  it('degrades to ABSENT (not empty) when the vocabulary read fails — never sinks the tab', async () => {
    // Absent and empty must stay distinguishable: the client treats `[]` as "no sources
    // exist" and falls back to its window-derived set only when the field is missing.
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    improvementSourceCounts.mockRejectedValue(new Error('source aggregate timed out'));
    readWatchdogFlowTicks.mockResolvedValue([]);

    const rows = await computeLearningImprovementsSnapshot({});

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceOptions).toBeUndefined();
  });

  it('reports an empty vocabulary as [] when the corpus genuinely has no sourced rows', async () => {
    readImprovementItems.mockResolvedValue([windowRow('EI-1')]);
    improvementSourceCounts.mockResolvedValue({ '': 12 });
    readWatchdogFlowTicks.mockResolvedValue([]);

    const row = (await computeLearningImprovementsSnapshot({}))[0];

    expect(row.sourceOptions).toEqual([]);
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
