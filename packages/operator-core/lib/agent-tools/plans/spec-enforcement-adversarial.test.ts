/**
 * spec-enforcement-adversarial.test.ts — P-014's adversarial + lifecycle suite.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT MORE PER-MODULE TESTS.
 *
 * `spec-enforcement-latency.ts`, `-escape.ts` and `-repeated-approach.ts` each carry a thorough
 * suite of their own (72 tests across five files as of 2026-08-24): null-vs-zero, denominator
 * reach, declared blind spots, and permanent wrong-implementation controls. Repeating any of
 * that here would add lines and no falsifiability.
 *
 * The gap those suites cannot see is BETWEEN the modules. All three read the SAME two sources
 * (`listWorkItemLifecycle`, the won-claim envelope) and compute INDEPENDENTLY — three separate
 * full-corpus scans per `plans:spec-reconciliation` call (EI-21348662211752936) — and they are
 * rendered as three blocks of ONE payload, which a reader inevitably reads as one story about
 * one corpus. Nothing asserted they agree. This file asserts it, and the first two things it
 * found were real:
 *
 *   1. `SpecEnforcementEscapeRollup.coverage.itemsRead` was documented as "Non-observation items
 *      the reader returned" while it is assigned `read.rows.length` — every row, observations
 *      included. Same field name, same payload, different population from what the doc claims.
 *   2. The observation exclusion was reported under THREE different definitions: latency counted
 *      SQL-excluded PLUS rows it defensively dropped itself; repeated counted only the
 *      SQL-excluded ones while ALSO dropping rows defensively (so its own drops vanished from
 *      its coverage); escape did not report the exclusion at all. Under any reader that does not
 *      pre-filter, one payload carried two different answers to "how many observations were
 *      excluded" and no answer from the third block.
 *
 * Both are the D-024 failure exactly: a number under a name that does not mean what the name
 * says, indistinguishable from a correct one at every later read.
 *
 * THE ELEVEN SCENARIOS. P-014 names eleven adversarial shapes. Each is mapped here onto a
 * concrete, reachable failure in THIS substrate rather than a generic gesture, and each is
 * registered in a self-census (below) so that skipping or renaming one FAILS the suite instead
 * of quietly shrinking it.
 *
 * WHAT THIS FILE CANNOT CATCH — stated rather than left implied, per D-024. The self-census
 * detects a scenario that was skipped or renamed while the file still runs. It cannot detect the
 * file never being COLLECTED at all: a suite that does not run reports nothing, and nothing is
 * what a green run also reports. That case is covered one layer up by `npm run lint:tests`,
 * which fails when a canonical `*.test.ts` matches no registry glob. The two guards are
 * complementary and neither subsumes the other.
 */
import { describe, expect, it } from 'vitest';
import {
  LATENCY_ITEM_LIMIT,
  LATENCY_NOT_DERIVABLE,
  computeSpecEnforcementLatency,
  type FirstClaimRow,
  type SpecEnforcementLatencyDeps,
  type SpecEnforcementLatencyLedger,
  type WorkItemLifecycleRow,
} from './spec-enforcement-latency';
import {
  ESCAPE_REWORK_GRACE_MS,
  computeSpecEnforcementEscape,
  type SpecEnforcementEscapeDeps,
  type SpecEnforcementEscapeLedger,
} from './spec-enforcement-escape';
import {
  computeSpecEnforcementRepeatedApproach,
  itemIdFromCheckpointScope,
  type SpecEnforcementRepeatedApproachDeps,
  type SpecEnforcementRepeatedApproachLedger,
} from './spec-enforcement-repeated-approach';
import { enforcementEligibility, type PlanAdoptionRow } from './spec-enforcement-eligibility';

// ---------------------------------------------------------------------------
// The scenario self-census — the `skipped/uncollected` scenario's own mechanism
// ---------------------------------------------------------------------------

const SCENARIOS = [
  'vacuous-fixture',
  'wrong-layer',
  'copied-oracle',
  'skipped-or-uncollected',
  'surviving-mutant',
  'stale-revision',
  'concurrent-edit',
  'sibling-history',
  'retraction-under-budget',
  'legacy-migration',
  'controlled-repeat-attempt',
] as const;
type Scenario = (typeof SCENARIOS)[number];

/** Filled at RUN time, never at collection time — a skipped test cannot register itself. */
const exercised = new Set<Scenario>();
function exercises(scenario: Scenario): void {
  exercised.add(scenario);
}

// ---------------------------------------------------------------------------
// One world, three readers. Typed factories only — never a cast.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const MIN = 60_000;

/**
 * A cast (`{ … } as WorkItemLifecycleRow`) would let a fixture omit a declared field and still
 * compile. That is instance #1 of the vacuous-fixture bug found on this plan, so the factories
 * are the fix and the rule: every fixture in this file goes through one.
 */
function item(over: Partial<WorkItemLifecycleRow> & { workItemId: string }): WorkItemLifecycleRow {
  return {
    sourcePlanSlug: null,
    lane: null,
    status: 'done',
    takenAtMs: null,
    lastProgressAtMs: null,
    closedAtMs: null,
    ...over,
  };
}

function claim(over: Partial<FirstClaimRow> & { workItemId: string }): FirstClaimRow {
  return { firstWonAtMs: T0, lastWonAtMs: T0, wonClaimCount: 1, distinctClaimants: 1, ...over };
}

function plan(over: Partial<PlanAdoptionRow> & { planSlug: string }): PlanAdoptionRow {
  return { status: 'active', clauseCount: 3, legacyValSignal: false, ...over };
}

/** The shared corpus all three measures read. One world, so disagreement is the modules'. */
interface World {
  items: WorkItemLifecycleRow[];
  claims: FirstClaimRow[];
  plans: PlanAdoptionRow[];
  /** Items carrying a non-empty durable carry-note. */
  checkpointed: string[];
  /** What the READER already excluded in SQL, before these modules saw anything. */
  observationsExcluded: number;
}

function world(over: Partial<World> = {}): World {
  return { items: [], claims: [], plans: [], checkpointed: [], observationsExcluded: 0, ...over };
}

function latencyDeps(w: World): SpecEnforcementLatencyDeps {
  return {
    listWorkItemLifecycle: async () => ({ rows: w.items, observationsExcluded: w.observationsExcluded }),
    listFirstClaims: async () => w.claims,
    listPlanAdoption: async () => w.plans,
  };
}

function escapeDeps(w: World): SpecEnforcementEscapeDeps {
  return {
    listWorkItemLifecycle: async () => ({ rows: w.items, observationsExcluded: w.observationsExcluded }),
    listWonClaims: async () => w.claims,
    listPlanAdoption: async () => w.plans,
  };
}

function repeatedDeps(w: World): SpecEnforcementRepeatedApproachDeps {
  return {
    listWorkItemLifecycle: async () => ({ rows: w.items, observationsExcluded: w.observationsExcluded }),
    listWonClaims: async () => w.claims,
    listCheckpointedItems: async () => w.checkpointed,
    listPlanAdoption: async () => w.plans,
  };
}

interface AllThree {
  latency: SpecEnforcementLatencyLedger;
  escape: SpecEnforcementEscapeLedger;
  repeated: SpecEnforcementRepeatedApproachLedger;
}

async function runAll(w: World, opts: { itemLimit?: number } = {}): Promise<AllThree> {
  const [latency, escape, repeated] = await Promise.all([
    computeSpecEnforcementLatency(latencyDeps(w), opts),
    computeSpecEnforcementEscape(escapeDeps(w), opts),
    computeSpecEnforcementRepeatedApproach(repeatedDeps(w), opts),
  ]);
  return { latency, escape, repeated };
}

/**
 * A corpus exercising every branch the three measures partition on, at once. Deliberately ONE
 * fixture: a per-scenario fixture cannot expose a disagreement between measures.
 */
function sharedWorld(): World {
  return world({
    items: [
      // enforced plan, claimed once, closed cleanly
      item({ workItemId: 'WI-1', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + 10 * MIN, lastProgressAtMs: T0 + 5 * MIN }),
      // enforced plan, re-attempted twice then closed — the repeat chain
      item({ workItemId: 'WI-2', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + 40 * MIN, lastProgressAtMs: T0 + 35 * MIN }),
      // enforced plan, closed then reclaimed well after the grace — an escape
      item({ workItemId: 'WI-3', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + 20 * MIN, lastProgressAtMs: T0 + 15 * MIN }),
      // legacy-VAL-only plan — enforceable lane, NOT enforcing
      item({ workItemId: 'WI-4', sourcePlanSlug: 'p-legacy', takenAtMs: T0, closedAtMs: T0 + 30 * MIN }),
      // no plan at all — unattributed, never folded into not-enforced
      item({ workItemId: 'WI-5', sourcePlanSlug: null, takenAtMs: T0, closedAtMs: T0 + 12 * MIN }),
      // closed but invisible to the ledger — coverage, never denominator
      item({ workItemId: 'WI-6', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + 8 * MIN }),
      // never closed
      item({ workItemId: 'WI-7', sourcePlanSlug: 'p-adopted', takenAtMs: T0, status: 'open' }),
      // a turn-end note that the reader did NOT pre-filter — the defensive-drop case
      item({ workItemId: 'WI-8', sourcePlanSlug: 'p-adopted', lane: 'observation', takenAtMs: T0, closedAtMs: T0 + 3 * MIN }),
    ],
    claims: [
      claim({ workItemId: 'WI-1', firstWonAtMs: T0, lastWonAtMs: T0 }),
      claim({ workItemId: 'WI-2', firstWonAtMs: T0, lastWonAtMs: T0 + 30 * MIN, wonClaimCount: 3, distinctClaimants: 2 }),
      claim({ workItemId: 'WI-3', firstWonAtMs: T0, lastWonAtMs: T0 + 25 * MIN, wonClaimCount: 2, distinctClaimants: 2 }),
      claim({ workItemId: 'WI-4', firstWonAtMs: T0, lastWonAtMs: T0 }),
      claim({ workItemId: 'WI-5', firstWonAtMs: T0, lastWonAtMs: T0 }),
      claim({ workItemId: 'WI-7', firstWonAtMs: T0, lastWonAtMs: T0 }),
      // WI-8 is an observation: it carries a claim row, so any measure that FAILS to drop it
      // would silently pull it into a denominator.
      claim({ workItemId: 'WI-8', firstWonAtMs: T0, lastWonAtMs: T0 }),
    ],
    plans: [
      plan({ planSlug: 'p-adopted', status: 'active', clauseCount: 2 }),
      plan({ planSlug: 'p-legacy', status: 'active', clauseCount: 0, legacyValSignal: true }),
    ],
    checkpointed: ['WI-2'],
    observationsExcluded: 4,
  });
}

// ---------------------------------------------------------------------------
// Leg A — cross-rollup consistency. The lifecycle E2E, in pure form.
// ---------------------------------------------------------------------------

describe('cross-rollup consistency — three independent scans, one corpus', () => {
  it('reports the SAME items-read population from all three blocks', async () => {
    const all = await runAll(sharedWorld());
    expect(all.latency.rollup.bounded.itemsRead).toBe(8);
    expect(all.escape.rollup.coverage.itemsRead).toBe(8);
    expect(all.repeated.rollup.coverage.itemsRead).toBe(8);
  });

  it('reports the SAME observation exclusion from all three blocks', async () => {
    // The reader pre-excluded 4 in SQL; WI-8 arrived anyway and every module drops it
    // defensively. A block that reports 4 is under-reporting its OWN drop.
    const all = await runAll(sharedWorld());
    expect(all.latency.rollup.excluded.observations).toBe(5);
    expect(all.repeated.rollup.coverage.observationsExcluded).toBe(5);
    expect(all.escape.rollup.coverage.observationsExcluded).toBe(5);
  });

  it('CALIBRATION: with a pre-filtering reader all three agree at the reader’s own count', async () => {
    // Guards the assertion above against the opposite error — a module that always adds its
    // defensive drop would over-report here, where there is nothing left to drop.
    const w = sharedWorld();
    w.items = w.items.filter((r) => r.lane !== 'observation');
    w.observationsExcluded = 5;
    const all = await runAll(w);
    expect(all.latency.rollup.excluded.observations).toBe(5);
    expect(all.repeated.rollup.coverage.observationsExcluded).toBe(5);
    expect(all.escape.rollup.coverage.observationsExcluded).toBe(5);
  });

  it('assigns every item to the SAME enforcement bucket in every block', async () => {
    const all = await runAll(sharedWorld());
    const bucketByItem = (rows: readonly { workItemId: string; bucket: string }[]) =>
      new Map(rows.map((r) => [r.workItemId, r.bucket]));

    const fromLatency = bucketByItem(all.latency.rows);
    const fromEscape = bucketByItem(all.escape.rows);
    const fromRepeated = bucketByItem(all.repeated.rows);

    // Non-vacuity: an empty intersection would make this pass while proving nothing.
    const shared = [...fromLatency.keys()].filter((id) => fromEscape.has(id) || fromRepeated.has(id));
    expect(shared.length).toBeGreaterThan(0);

    for (const id of shared) {
      const expectedBucket = fromLatency.get(id);
      if (fromEscape.has(id)) expect(`${id}:${fromEscape.get(id)}`).toBe(`${id}:${expectedBucket}`);
      if (fromRepeated.has(id)) expect(`${id}:${fromRepeated.get(id)}`).toBe(`${id}:${expectedBucket}`);
    }
  });

  /**
   * The honest form of the invariant, and a caution about how easy the dishonest form is.
   *
   * The first cut of this test derived "was it claimed before the close?" from the escape row
   * alone, as `reclaimedAtMs - gapMs === closedAtMs`. That identity holds by CONSTRUCTION —
   * `gapMs` is defined as `lastWonAtMs - closedAtMs` — so the condition was always true and the
   * test discriminated nothing while appearing to guard a real property. It is exactly the
   * vacuous shape this file exists to catch, produced by this file, on its first run. The fix
   * is to read the FIRST claim from the shared envelope, which the escape row deliberately does
   * not carry.
   */
  it('requires a re-attempt for every escape that was already claimed before its close', async () => {
    const w = sharedWorld();
    const all = await runAll(w);
    const claimsById = new Map(w.claims.map((c) => [c.workItemId, c]));

    const priorClaimEscapes = all.escape.rows.filter(
      (r) => (claimsById.get(r.workItemId)?.firstWonAtMs ?? Infinity) < r.closedAtMs,
    );
    expect(priorClaimEscapes.length).toBeGreaterThan(0);

    for (const row of priorClaimEscapes) {
      expect(claimsById.get(row.workItemId)!.wonClaimCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('does NOT demand a re-attempt for an escape first claimed only AFTER the close', async () => {
    // The discriminating case that proves the rule above is a real filter and not a tautology:
    // an item closed unclaimed and picked up later escapes with exactly one won claim.
    const w = world({
      items: [item({ workItemId: 'WI-LATE', sourcePlanSlug: 'p-adopted', closedAtMs: T0 + 5 * MIN })],
      claims: [claim({ workItemId: 'WI-LATE', firstWonAtMs: T0 + 50 * MIN, lastWonAtMs: T0 + 50 * MIN })],
      plans: [plan({ planSlug: 'p-adopted', clauseCount: 2 })],
    });
    const { escape, repeated } = await runAll(w);
    expect(escape.rollup.escapedItems).toBe(1);
    expect(repeated.rollup.reattemptedItems).toBe(0);
    expect(w.claims[0].firstWonAtMs).toBeGreaterThan(w.items[0].closedAtMs!);
  });

  it('flips every block’s floor flag together when one shared read truncates', async () => {
    const all = await runAll(sharedWorld(), { itemLimit: 8 });
    expect(all.latency.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(all.escape.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(all.repeated.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(all.latency.rollup.bounded.countsAreFloor).toBe(true);
    expect(all.escape.rollup.bounded.countsAreFloor).toBe(true);
    expect(all.repeated.rollup.bounded.countsAreFloor).toBe(true);
  });

  it('CALIBRATION: no block claims a floor when the read came in under the limit', async () => {
    const all = await runAll(sharedWorld(), { itemLimit: LATENCY_ITEM_LIMIT });
    expect(all.latency.rollup.bounded.countsAreFloor).toBe(false);
    expect(all.escape.rollup.bounded.countsAreFloor).toBe(false);
    expect(all.repeated.rollup.bounded.countsAreFloor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leg B — the vacuous-fixture detector, calibrated on two REAL instances
// ---------------------------------------------------------------------------

/**
 * Why a detector and not another assertion: both real instances found on this plan compiled,
 * produced populated-looking output, and passed their suites. What they shared is a structural
 * signature a generic check CAN see — a partition that accumulated somewhere the declared
 * vocabulary does not name, or a partition that reconciles to a total only because both sides
 * are empty. Returns the reasons rather than throwing, so the negative direction is assertable.
 */
function vacuityFindings(
  partition: Record<string, unknown>,
  declaredKeys: readonly string[],
  total: number,
  laneTotal: (lane: unknown) => number,
): string[] {
  const findings: string[] = [];
  for (const key of Object.keys(partition)) {
    if (!declaredKeys.includes(key)) findings.push(`accumulated under an undeclared key: ${key}`);
  }
  for (const key of declaredKeys) {
    if (!(key in partition)) findings.push(`declared lane absent from the partition: ${key}`);
    else if (partition[key] === undefined) findings.push(`declared lane present but undefined: ${key}`);
  }
  const sum = declaredKeys.reduce((acc, k) => acc + laneTotal(partition[k]), 0);
  if (sum !== total) findings.push(`partition sums to ${sum}, flat total is ${total}`);
  if (total === 0) findings.push('reconciles vacuously — both sides are zero, so nothing is proven');
  return findings;
}

const BUCKETS = ['enforced', 'not-enforced', 'unattributed'] as const;

describe('vacuous-fixture — a detector calibrated on the two real instances', () => {
  it('KNOWN POSITIVE #1: the `as Aggregate` cast that left a declared lane undefined', async () => {
    exercises('vacuous-fixture');
    // Instance #1 verbatim in shape: a cast let the fixture omit a lane, so every rollup test
    // ran against `byBehaviorClass: undefined` and still reconciled.
    const casted = { enforced: { detectable: 2, escaped: 1 }, 'not-enforced': { detectable: 1, escaped: 0 } } as unknown as Record<
      string,
      { detectable: number; escaped: number }
    >;
    const findings = vacuityFindings(casted, BUCKETS, 3, (l) => (l as { detectable: number } | undefined)?.detectable ?? 0);
    expect(findings).toContain('declared lane absent from the partition: unattributed');
  });

  it('KNOWN POSITIVE #2: accumulation under an `undefined` key from a loosely typed stub', async () => {
    exercises('vacuous-fixture');
    // Instance #2 verbatim in shape: a `listEvidence` stub typed loosely enough that a
    // composition accumulated under `undefined`, which reads as populated.
    const accumulated: Record<string, { detectable: number; escaped: number }> = {
      enforced: { detectable: 1, escaped: 0 },
      'not-enforced': { detectable: 0, escaped: 0 },
      unattributed: { detectable: 0, escaped: 0 },
      undefined: { detectable: 5, escaped: 3 },
    };
    const findings = vacuityFindings(accumulated, BUCKETS, 1, (l) => (l as { detectable: number }).detectable);
    expect(findings).toContain('accumulated under an undeclared key: undefined');
  });

  it('KNOWN POSITIVE #3: a partition that reconciles only because everything is zero', () => {
    exercises('vacuous-fixture');
    const empty: Record<string, { detectable: number; escaped: number }> = {
      enforced: { detectable: 0, escaped: 0 },
      'not-enforced': { detectable: 0, escaped: 0 },
      unattributed: { detectable: 0, escaped: 0 },
    };
    const findings = vacuityFindings(empty, BUCKETS, 0, (l) => (l as { detectable: number }).detectable);
    expect(findings).toContain('reconciles vacuously — both sides are zero, so nothing is proven');
  });

  it('NEGATIVE CONTROL: the real escape partition is clean — so the detector is not always-on', async () => {
    exercises('vacuous-fixture');
    const { escape } = await runAll(sharedWorld());
    const findings = vacuityFindings(
      escape.rollup.byEnforcement as unknown as Record<string, unknown>,
      BUCKETS,
      escape.rollup.detectableItems,
      (l) => (l as { detectable: number }).detectable,
    );
    expect(findings).toEqual([]);
    expect(escape.rollup.detectableItems).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the real repeated-approach partition is clean too', async () => {
    exercises('vacuous-fixture');
    const { repeated } = await runAll(sharedWorld());
    const findings = vacuityFindings(
      repeated.rollup.byEnforcement as unknown as Record<string, unknown>,
      BUCKETS,
      repeated.rollup.detectableItems,
      (l) => (l as { detectableItems: number }).detectableItems,
    );
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Leg C — the remaining named scenarios
// ---------------------------------------------------------------------------

describe('copied-oracle — expectations derived from the spec, not from the implementation', () => {
  /**
   * Written from D-024 and the field docs, without reading the counting code. If production
   * disagrees with this, one of the two is wrong and the disagreement is the finding — which is
   * the entire point of not copying the oracle.
   */
  function independentRepeatOracle(w: World) {
    const claimable = w.items.filter((r) => r.lane !== 'observation');
    const byId = new Map(w.claims.map((c) => [c.workItemId, c]));
    const withLedger = claimable.filter((r) => byId.has(r.workItemId));
    const attempts = withLedger.map((r) => byId.get(r.workItemId)!.wonClaimCount);
    return {
      detectableItems: withLedger.length,
      reattemptedItems: attempts.filter((n) => n > 1).length,
      reattempts: attempts.reduce((a, n) => a + Math.max(0, n - 1), 0),
      repeatedFailures: attempts.reduce((a, n) => a + Math.max(0, n - 2), 0),
      deepestChain: attempts.length === 0 ? 0 : Math.max(...attempts),
    };
  }

  it('agrees with an independently derived repeat oracle', async () => {
    exercises('copied-oracle');
    const w = sharedWorld();
    const { repeated } = await runAll(w);
    const oracle = independentRepeatOracle(w);
    expect({
      detectableItems: repeated.rollup.detectableItems,
      reattemptedItems: repeated.rollup.reattemptedItems,
      reattempts: repeated.rollup.reattempts,
      repeatedFailures: repeated.rollup.repeatedFailures,
      deepestChain: repeated.rollup.deepestChain,
    }).toEqual(oracle);
  });

  it('CONTROL: a mutant oracle that forgets to subtract the first attempt DISAGREES', async () => {
    exercises('copied-oracle');
    const w = sharedWorld();
    const { repeated } = await runAll(w);
    const mutant = w.claims
      .filter((c) => w.items.some((r) => r.workItemId === c.workItemId && r.lane !== 'observation'))
      .reduce((a, c) => a + c.wonClaimCount, 0);
    expect(repeated.rollup.reattempts).not.toBe(mutant);
  });

  it('agrees with an independently derived escape oracle', async () => {
    exercises('copied-oracle');
    const w = sharedWorld();
    const { escape } = await runAll(w);
    const byId = new Map(w.claims.map((c) => [c.workItemId, c]));
    const closedWithLedger = w.items.filter(
      (r) => r.lane !== 'observation' && r.closedAtMs != null && byId.has(r.workItemId),
    );
    const escaped = closedWithLedger.filter(
      (r) => byId.get(r.workItemId)!.lastWonAtMs - r.closedAtMs! > ESCAPE_REWORK_GRACE_MS,
    );
    expect(escape.rollup.detectableItems).toBe(closedWithLedger.length);
    expect(escape.rollup.escapedItems).toBe(escaped.length);
    expect(escaped.length).toBeGreaterThan(0);
  });

  it('agrees with a nearest-rank percentile derived from its standard definition', async () => {
    exercises('copied-oracle');
    const w = sharedWorld();
    const { latency } = await runAll(w);
    const durations = latency.rows
      .map((r) => r.claimToCompletionMs)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b);
    // Nearest-rank: 1-based index ceil(p × n) over the ascending sample.
    const nearestRank = (f: number) => (durations.length === 0 ? null : durations[Math.ceil(f * durations.length) - 1]);
    const pooled = [
      latency.rollup.byEnforcement.enforced,
      latency.rollup.byEnforcement['not-enforced'],
      latency.rollup.byEnforcement.unattributed,
    ];
    expect(pooled.reduce((a, l) => a + l.claimToCompletion.n, 0)).toBe(durations.length);
    expect(nearestRank(0.5)).not.toBeNull();
    // The per-lane distributions are computed the same way over their own samples: verify the
    // definition on the lane that carries the largest sample rather than on a pooled number the
    // implementation never claims to produce.
    const biggest = pooled.reduce((a, b) => (b.claimToCompletion.n > a.claimToCompletion.n ? b : a));
    const laneDurations = latency.rows
      .filter((r) => r.claimToCompletionMs != null)
      .filter((r) => r.bucket === (biggest === latency.rollup.byEnforcement.enforced ? 'enforced' : r.bucket))
      .map((r) => r.claimToCompletionMs!)
      .sort((a, b) => a - b);
    if (biggest === latency.rollup.byEnforcement.enforced) {
      expect(biggest.claimToCompletion.p50Ms).toBe(laneDurations[Math.ceil(0.5 * laneDurations.length) - 1]);
    }
  });

  it('reports every rate as NULL on an empty world — never as a clean zero', async () => {
    exercises('copied-oracle');
    const all = await runAll(world());
    expect(all.escape.rollup.escapesPerThousand).toBeNull();
    expect(all.repeated.rollup.repeatedFailuresPerThousand).toBeNull();
    expect(all.repeated.rollup.unbriefablePerThousand).toBeNull();
    expect(all.latency.rollup.byEnforcement.enforced.claimToCompletion.p50Ms).toBeNull();
  });

  it('keeps the D-003 pairing readable only ALONGSIDE the null rate, not instead of it', async () => {
    exercises('copied-oracle');
    const all = await runAll(world());
    // `pairing.metric` is 0 when unmeasured, by the convention efficiency-metrics established.
    // A reader who consults it alone cannot tell unmeasured from clean — which is exactly why
    // the nullable rate must remain the authority.
    expect(all.repeated.rollup.pairing.metric).toBe(0);
    expect(all.repeated.rollup.repeatedFailuresPerThousand).toBeNull();
  });
});

describe('wrong-layer — a measure taken at one layer must not wear another layer’s name', () => {
  it('exposes claim-to-last-progress under its OWN name and no checkpoint alias', async () => {
    exercises('wrong-layer');
    const { latency } = await runAll(sharedWorld());
    const laneKeys = Object.keys(latency.rollup.byEnforcement.enforced);
    expect(laneKeys).toContain('claimToLastProgress');
    for (const forbidden of ['claimToCheckpoint', 'claimToFirstCheckpoint', 'checkpointLatency']) {
      expect(laneKeys).not.toContain(forbidden);
    }
    const rowKeys = Object.keys(latency.rows[0] ?? {});
    expect(rowKeys).not.toContain('claimToCheckpointMs');
  });

  it('declares the undeliverable checkpoint measure in-band rather than omitting it', async () => {
    exercises('wrong-layer');
    const { latency } = await runAll(sharedWorld());
    expect(latency.rollup.notDerivable).toBe(LATENCY_NOT_DERIVABLE);
    expect(latency.rollup.notDerivable.length).toBeGreaterThan(0);
    const text = latency.rollup.notDerivable.map((m) => `${m.measure} ${m.reason}`).join(' ').toLowerCase();
    expect(text).toContain('checkpoint');
  });
});

describe('surviving-mutant — permanent wrong-implementation controls', () => {
  it('CONTROL: folding `unattributed` into `not-enforced` moves a pinned count', async () => {
    exercises('surviving-mutant');
    const { escape } = await runAll(sharedWorld());
    const correct = escape.rollup.byEnforcement['not-enforced'].detectable;
    const mutant = correct + escape.rollup.byEnforcement.unattributed.detectable;
    expect(escape.rollup.byEnforcement.unattributed.detectable).toBeGreaterThan(0);
    expect(mutant).not.toBe(correct);
  });

  it('CONTROL: including unledgered closed items dilutes the escape rate measurably', async () => {
    exercises('surviving-mutant');
    const { escape } = await runAll(sharedWorld());
    const diluted =
      (escape.rollup.escapedItems /
        (escape.rollup.detectableItems + escape.rollup.coverage.closedItemsOutsideLedgerReach)) *
      1000;
    expect(escape.rollup.coverage.closedItemsOutsideLedgerReach).toBeGreaterThan(0);
    expect(escape.rollup.escapesPerThousand).not.toBeCloseTo(diluted, 6);
  });

  it('CALIBRATION: with nothing outside ledger reach the mutant and the truth coincide', async () => {
    exercises('surviving-mutant');
    const w = sharedWorld();
    w.claims = [...w.claims, claim({ workItemId: 'WI-6', firstWonAtMs: T0, lastWonAtMs: T0 })];
    const { escape } = await runAll(w);
    expect(escape.rollup.coverage.closedItemsOutsideLedgerReach).toBe(0);
    const diluted = (escape.rollup.escapedItems / escape.rollup.detectableItems) * 1000;
    expect(escape.rollup.escapesPerThousand).toBeCloseTo(diluted, 6);
  });
});

describe('stale-revision — an eligibility verdict is a function of CURRENT inputs only', () => {
  it('flips a plan out of enforcing the moment its clause count drops, with no memoisation', () => {
    exercises('stale-revision');
    const before = enforcementEligibility({ status: 'active', clauseCount: 2 });
    const after = enforcementEligibility({ status: 'active', clauseCount: 0 });
    expect(before.enforcing).toBe(true);
    expect(after.enforcing).toBe(false);
    expect(after.enforcing === false && after.reason).toBe('not-yet-reconciled');
  });

  it('keeps an item whose plan fell outside the bounded plan read UNATTRIBUTED, not not-enforced', async () => {
    exercises('stale-revision');
    // The plan read is bounded independently of the item read, so a large plan population can
    // leave an item's plan unresolvable. Unknown must never render as a negative verdict.
    const w = sharedWorld();
    w.plans = w.plans.filter((p) => p.planSlug !== 'p-adopted');
    const all = await runAll(w);
    const wi1 = all.latency.rows.find((r) => r.workItemId === 'WI-1');
    expect(wi1?.bucket).toBe('unattributed');
    expect(all.escape.rows.every((r) => r.bucket !== 'enforced')).toBe(true);
  });
});

describe('concurrent-edit — three scans of a corpus that changed between them', () => {
  /**
   * The three measures scan independently, so a write landing between scans yields three blocks
   * describing three different corpora — silently, because each block is internally consistent.
   * The reader's only defence is that all three publish their own `itemsRead`.
   */
  function snapshotAgreement(all: AllThree): { agrees: boolean; reads: number[] } {
    const reads = [
      all.latency.rollup.bounded.itemsRead,
      all.escape.rollup.coverage.itemsRead,
      all.repeated.rollup.coverage.itemsRead,
    ];
    return { agrees: new Set(reads).size === 1, reads };
  }

  it('is DETECTABLE from the published payload when the snapshots diverge', async () => {
    exercises('concurrent-edit');
    const base = sharedWorld();
    const grown = sharedWorld();
    grown.items = [...grown.items, item({ workItemId: 'WI-9', sourcePlanSlug: 'p-adopted', takenAtMs: T0 })];
    const [latency, escape, repeated] = await Promise.all([
      computeSpecEnforcementLatency(latencyDeps(base)),
      computeSpecEnforcementEscape(escapeDeps(grown)),
      computeSpecEnforcementRepeatedApproach(repeatedDeps(grown)),
    ]);
    const verdict = snapshotAgreement({ latency, escape, repeated });
    expect(verdict.agrees).toBe(false);
    expect(verdict.reads).toEqual([8, 9, 9]);
  });

  it('CALIBRATION: a stable snapshot agrees, so the detector is not always-on', async () => {
    exercises('concurrent-edit');
    expect(snapshotAgreement(await runAll(sharedWorld())).agrees).toBe(true);
  });
});

describe('sibling-history — one item’s history must never be credited to another', () => {
  it('does not cross-credit a carry-note whose id is a PREFIX of another item’s id', () => {
    exercises('sibling-history');
    const shortId = itemIdFromCheckpointScope('workitem:papercusp:WI-4009');
    const longId = itemIdFromCheckpointScope('workitem:papercusp:WI-40093');
    expect(shortId).toBe('WI-4009');
    expect(longId).toBe('WI-40093');
    expect(shortId).not.toBe(longId);
  });

  it('marks a re-attempted item unbriefable when only its SIBLING carried a note', async () => {
    exercises('sibling-history');
    const w = sharedWorld();
    // WI-2 is the re-attempted item; move its note onto an unrelated sibling.
    w.checkpointed = ['WI-1'];
    const { repeated } = await runAll(w);
    const wi2 = repeated.rows.find((r) => r.workItemId === 'WI-2');
    expect(wi2?.unbriefable).toBe(true);
  });

  it('CALIBRATION: the same item WITH its own note is briefable', async () => {
    exercises('sibling-history');
    const { repeated } = await runAll(sharedWorld());
    const wi2 = repeated.rows.find((r) => r.workItemId === 'WI-2');
    expect(wi2?.unbriefable).toBe(false);
  });
});

describe('retraction-under-budget — a cleared note is honoured, and a truncated read says so', () => {
  it('raises the unbriefable count when a note is retracted', async () => {
    exercises('retraction-under-budget');
    const withNote = await runAll(sharedWorld());
    const retracted = sharedWorld();
    retracted.checkpointed = [];
    const after = await runAll(retracted);
    expect(after.repeated.rollup.unbriefableReattemptedItems).toBeGreaterThan(
      withNote.repeated.rollup.unbriefableReattemptedItems,
    );
  });

  it('marks the unbriefable count a FLOOR when the item budget truncated the read', async () => {
    exercises('retraction-under-budget');
    const all = await runAll(sharedWorld(), { itemLimit: 8 });
    expect(all.repeated.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(all.repeated.rollup.bounded.countsAreFloor).toBe(true);
  });
});

describe('legacy-migration — a legacy-VAL plan is not-enforcing for a NAMED reason', () => {
  it('separates legacy-val-only from no-behavior-declared instead of pooling both as negative', () => {
    exercises('legacy-migration');
    const legacy = enforcementEligibility({ status: 'active', clauseCount: 0, legacyValSignal: true });
    const silent = enforcementEligibility({ status: 'active', clauseCount: 0, legacyValSignal: false });
    expect(legacy.enforcing).toBe(false);
    expect(silent.enforcing).toBe(false);
    expect(legacy.adoption).toBe('legacy-val-only');
    expect(silent.adoption).toBe('no-behavior-declared');
  });

  it('places a legacy-plan item in not-enforced — never in unattributed — across all blocks', async () => {
    exercises('legacy-migration');
    const all = await runAll(sharedWorld());
    expect(all.latency.rows.find((r) => r.workItemId === 'WI-4')?.bucket).toBe('not-enforced');
    expect(all.escape.rows.find((r) => r.workItemId === 'WI-4')?.bucket ?? 'not-enforced').toBe('not-enforced');
    expect(all.latency.rows.find((r) => r.workItemId === 'WI-4')?.adoption).toBe('legacy-val-only');
  });
});

describe('controlled-repeat-attempt — a deterministic attempt chain, oracled by hand', () => {
  it('moves each count by exactly one as the chain deepens', async () => {
    exercises('controlled-repeat-attempt');
    const observed: { attempts: number; reattempts: number; repeatedFailures: number; deepest: number }[] = [];
    for (const attempts of [1, 2, 3, 4]) {
      const w = world({
        items: [item({ workItemId: 'WI-C', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + MIN })],
        claims: [claim({ workItemId: 'WI-C', wonClaimCount: attempts, distinctClaimants: Math.min(attempts, 2) })],
        plans: [plan({ planSlug: 'p-adopted', clauseCount: 2 })],
        checkpointed: ['WI-C'],
      });
      const { repeated } = await runAll(w);
      observed.push({
        attempts,
        reattempts: repeated.rollup.reattempts,
        repeatedFailures: repeated.rollup.repeatedFailures,
        deepest: repeated.rollup.deepestChain,
      });
    }
    expect(observed).toEqual([
      { attempts: 1, reattempts: 0, repeatedFailures: 0, deepest: 1 },
      { attempts: 2, reattempts: 1, repeatedFailures: 0, deepest: 2 },
      { attempts: 3, reattempts: 2, repeatedFailures: 1, deepest: 3 },
      { attempts: 4, reattempts: 3, repeatedFailures: 2, deepest: 4 },
    ]);
  });

  it('separates a self-reclaim chain from a hand-off chain of the same depth', async () => {
    exercises('controlled-repeat-attempt');
    const build = (distinctClaimants: number) =>
      world({
        items: [item({ workItemId: 'WI-C', sourcePlanSlug: 'p-adopted', takenAtMs: T0, closedAtMs: T0 + MIN })],
        claims: [claim({ workItemId: 'WI-C', wonClaimCount: 3, distinctClaimants })],
        plans: [plan({ planSlug: 'p-adopted', clauseCount: 2 })],
        checkpointed: ['WI-C'],
      });
    const selfReclaim = await runAll(build(1));
    const handOff = await runAll(build(3));
    expect(selfReclaim.repeated.rollup.sameClaimantReattemptedItems).toBe(1);
    expect(handOff.repeated.rollup.sameClaimantReattemptedItems).toBe(0);
    // The headline rate is deliberately identical — which is why the split must be published.
    expect(selfReclaim.repeated.rollup.repeatedFailuresPerThousand).toBe(
      handOff.repeated.rollup.repeatedFailuresPerThousand,
    );
  });
});

// ---------------------------------------------------------------------------
// The census. Declared LAST so it observes the whole file.
// ---------------------------------------------------------------------------

describe('skipped-or-uncollected — the suite counts itself', () => {
  it('exercised every scenario P-014 names', () => {
    exercises('skipped-or-uncollected');
    const missing = SCENARIOS.filter((s) => !exercised.has(s));
    expect(missing).toEqual([]);
    // Non-vacuity: an empty manifest would make the line above pass while proving nothing.
    expect(SCENARIOS.length).toBe(11);
    expect(exercised.size).toBe(SCENARIOS.length);
  });
});
