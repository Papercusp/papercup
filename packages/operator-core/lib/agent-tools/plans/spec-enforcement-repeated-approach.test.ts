import { describe, expect, it } from 'vitest';
import {
  REPEATED_APPROACH_NOT_DERIVABLE,
  computeSpecEnforcementRepeatedApproach,
  type SpecEnforcementRepeatedApproachDeps,
} from './spec-enforcement-repeated-approach';
import type { FirstClaimRow, WorkItemLifecycleRow } from './spec-enforcement-latency';
import type { PlanAdoptionRow } from './spec-enforcement-eligibility';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);

/** Typed factory, never a cast — a cast lets a fixture omit a declared field, which is exactly
 *  how a partition goes vacuous while looking populated. */
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

function deps(input: {
  items: WorkItemLifecycleRow[];
  claims?: FirstClaimRow[];
  plans?: PlanAdoptionRow[];
  checkpointed?: string[];
  observationsExcluded?: number;
}): SpecEnforcementRepeatedApproachDeps {
  return {
    listWorkItemLifecycle: async () => ({
      rows: input.items,
      observationsExcluded: input.observationsExcluded ?? 0,
    }),
    listWonClaims: async () => input.claims ?? [],
    listCheckpointedItems: async () => input.checkpointed ?? [],
    listPlanAdoption: async () => input.plans ?? [],
  };
}

describe('computeSpecEnforcementRepeatedApproach — what counts as a repeated failure', () => {
  it('counts nothing for an item claimed exactly once', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' })],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 1 })],
      }),
    );

    expect(ledger.rollup.detectableItems).toBe(1);
    expect(ledger.rollup.reattemptedItems).toBe(0);
    expect(ledger.rollup.reattempts).toBe(0);
    expect(ledger.rollup.repeatedFailures).toBe(0);
  });

  it('counts a SECOND claim as a re-attempt but NOT yet as a repeated failure', async () => {
    // Two claims: the first failed (a later claim follows it), the second is a re-attempt whose
    // own outcome is not yet evidenced. Counting it as a repeat would manufacture a defect out
    // of work that may well have succeeded.
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' })],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 2, distinctClaimants: 2 })],
      }),
    );

    expect(ledger.rollup.reattempts).toBe(1);
    expect(ledger.rollup.repeatedFailures).toBe(0);
    expect(ledger.rollup.repeatedFailuresPerThousand).toBe(0);
  });

  it('counts the THIRD claim as a repeated failure — the re-attempt itself failed', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' })],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 3, distinctClaimants: 3 })],
      }),
    );

    expect(ledger.rollup.reattempts).toBe(2);
    expect(ledger.rollup.repeatedFailures).toBe(1);
    expect(ledger.rollup.repeatedFailuresPerThousand).toBe(500);
    expect(ledger.rows[0]?.attempts).toBe(3);
    expect(ledger.rollup.deepestChain).toBe(3);
  });

  it('reports an UNMEASURED rate as null, never as a clean zero', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({ items: [item({ workItemId: 'WI-1' })], claims: [claim({ workItemId: 'WI-1' })] }),
    );

    expect(ledger.rollup.reattempts).toBe(0);
    expect(ledger.rollup.repeatedFailuresPerThousand).toBeNull();
    expect(ledger.rollup.unbriefablePerThousand).toBeNull();
  });
});

describe('the denominator is the instrument’s REACH, not the corpus', () => {
  it('excludes items with no ledger row instead of diluting the rate with them', async () => {
    // One detectable item that repeated, plus 8 items the ledger cannot see at all. The honest
    // rate is 1000‰ over the reach; folding the invisible 8 into the denominator would report
    // ~111‰ and let ledger COVERAGE masquerade as quality.
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [
          item({ workItemId: 'WI-1' }),
          ...Array.from({ length: 8 }, (_v, i) => item({ workItemId: `WI-blind-${i}` })),
        ],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 3 })],
      }),
    );

    expect(ledger.rollup.detectableItems).toBe(1);
    expect(ledger.rollup.coverage.itemsOutsideLedgerReach).toBe(8);
    expect(ledger.rollup.repeatedFailuresPerThousand).toBe(500);

    // FALSIFIABILITY CONTROL — a permanent wrong implementation kept in the file. If the module
    // ever folded the out-of-reach items into the denominator, the rate would read as this
    // number instead. The two must differ, or the test above proves nothing.
    const diluted = (ledger.rollup.repeatedFailures / ledger.rollup.coverage.itemsRead) * 1000;
    expect(diluted).not.toBe(ledger.rollup.repeatedFailuresPerThousand);
    expect(Math.round(diluted)).toBe(111);
  });

  it('excludes observation-lane rows and reports how many it excluded', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' }), item({ workItemId: 'OBS-1', lane: 'observation' })],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 3 }), claim({ workItemId: 'OBS-1', wonClaimCount: 9 })],
        observationsExcluded: 41,
      }),
    );

    expect(ledger.rollup.detectableItems).toBe(1);
    expect(ledger.rollup.deepestChain).toBe(3);
    expect(ledger.rollup.coverage.observationsExcluded).toBe(41);
  });
});

describe('the D-003 pairing — the metric must not be readable alone', () => {
  it('reports a re-attempt whose prior holder left NO note as unbriefable', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' }), item({ workItemId: 'WI-2' })],
        claims: [
          claim({ workItemId: 'WI-1', wonClaimCount: 2 }),
          claim({ workItemId: 'WI-2', wonClaimCount: 2 }),
        ],
        checkpointed: ['WI-1'],
      }),
    );

    expect(ledger.rollup.reattemptedItems).toBe(2);
    expect(ledger.rollup.unbriefableReattemptedItems).toBe(1);
    expect(ledger.rollup.unbriefablePerThousand).toBe(500);
  });

  it('surfaces the gaming mode: leaving LESS behind improves the metric but worsens its pair', async () => {
    // The SAME two re-attempted items, differing only in whether a durable note exists. The
    // favourable metric is identical in both worlds; only the paired failure moves. That is the
    // whole point of the pairing — a scorer that reads `metric` alone cannot tell these apart.
    const world = (checkpointed: string[]) =>
      computeSpecEnforcementRepeatedApproach(
        deps({
          items: [item({ workItemId: 'WI-1' }), item({ workItemId: 'WI-2' })],
          claims: [
            claim({ workItemId: 'WI-1', wonClaimCount: 3 }),
            claim({ workItemId: 'WI-2', wonClaimCount: 3 }),
          ],
          checkpointed,
        }),
      );
    const withNotes = await world(['WI-1', 'WI-2']);
    const withoutNotes = await world([]);

    // A NON-ZERO metric, identical in both worlds — so the assertion cannot pass merely because
    // both happen to be zero.
    expect(withNotes.rollup.pairing.metric).toBe(500);
    expect(withoutNotes.rollup.pairing.metric).toBe(withNotes.rollup.pairing.metric);
    expect(withNotes.rollup.pairing.pairedFailure).toBe(0);
    expect(withoutNotes.rollup.pairing.pairedFailure).toBe(1000);
    expect(withNotes.rollup.pairing.pairName).toBe('unbriefableReattemptRate');
  });

  it('separates a self-reclaim from a hand-off to a fresh claimant', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' }), item({ workItemId: 'WI-2' })],
        claims: [
          claim({ workItemId: 'WI-1', wonClaimCount: 3, distinctClaimants: 1 }),
          claim({ workItemId: 'WI-2', wonClaimCount: 3, distinctClaimants: 3 }),
        ],
      }),
    );

    expect(ledger.rollup.reattemptedItems).toBe(2);
    expect(ledger.rollup.sameClaimantReattemptedItems).toBe(1);
  });
});

describe('the enforcement partition', () => {
  it('splits by the SHARED eligibility classifier and never folds unattributed into not-enforced', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [
          item({ workItemId: 'WI-1', sourcePlanSlug: 'enforcing-plan' }),
          item({ workItemId: 'WI-2', sourcePlanSlug: 'draft-plan' }),
          item({ workItemId: 'WI-3', sourcePlanSlug: null }),
        ],
        claims: [
          claim({ workItemId: 'WI-1', wonClaimCount: 3 }),
          claim({ workItemId: 'WI-2', wonClaimCount: 3 }),
          claim({ workItemId: 'WI-3', wonClaimCount: 3 }),
        ],
        plans: [
          plan({ planSlug: 'enforcing-plan', status: 'active', clauseCount: 3 }),
          plan({ planSlug: 'draft-plan', status: 'draft', clauseCount: 0 }),
        ],
      }),
    );

    expect(ledger.rollup.byEnforcement.enforced.repeatedFailures).toBe(1);
    expect(ledger.rollup.byEnforcement['not-enforced'].repeatedFailures).toBe(1);

    // CONTROL: `unattributed` is its OWN bucket. Merging "could not tell" into the negative arm
    // would grow the very partition being measured, so BOTH counts are pinned.
    expect(ledger.rollup.byEnforcement.unattributed.repeatedFailures).toBe(1);
    expect(ledger.rollup.byEnforcement['not-enforced'].detectableItems).toBe(1);
    expect(ledger.rollup.byEnforcement.unattributed.detectableItems).toBe(1);
  });

  it('reconciles the partition against the flat totals, non-vacuously', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [
          item({ workItemId: 'WI-1', sourcePlanSlug: 'enforcing-plan' }),
          item({ workItemId: 'WI-2', sourcePlanSlug: null }),
        ],
        claims: [
          claim({ workItemId: 'WI-1', wonClaimCount: 4 }),
          claim({ workItemId: 'WI-2', wonClaimCount: 3 }),
        ],
        plans: [plan({ planSlug: 'enforcing-plan', status: 'active', clauseCount: 3 })],
      }),
    );

    const lanes = Object.values(ledger.rollup.byEnforcement);
    const summed = lanes.reduce((a, l) => a + l.repeatedFailures, 0);

    // A `sum === total` check passes trivially when both are 0 — which is precisely what an
    // unpopulated partition produces. Assert the totals are non-zero FIRST.
    expect(ledger.rollup.repeatedFailures).toBeGreaterThan(0);
    expect(summed).toBe(ledger.rollup.repeatedFailures);
    expect(lanes.reduce((a, l) => a + l.detectableItems, 0)).toBe(ledger.rollup.detectableItems);
  });
});

describe('honesty declarations', () => {
  it('declares that approach IDENTITY is not derivable, not merely unmeasured', async () => {
    const measures = REPEATED_APPROACH_NOT_DERIVABLE.map((n) => n.measure);
    expect(measures).toContain('whether the SAME approach was retried');

    const ledger = await computeSpecEnforcementRepeatedApproach(deps({ items: [] }));
    expect(ledger.rollup.notDerivable).toBe(REPEATED_APPROACH_NOT_DERIVABLE);
    expect(REPEATED_APPROACH_NOT_DERIVABLE.every((n) => n.reason.length > 0)).toBe(true);
  });

  it('marks counts as a FLOOR when the item limit truncated the read', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({
        items: [item({ workItemId: 'WI-1' }), item({ workItemId: 'WI-2' })],
        claims: [claim({ workItemId: 'WI-1', wonClaimCount: 3 })],
      }),
      { itemLimit: 2 },
    );

    expect(ledger.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(ledger.rollup.bounded.countsAreFloor).toBe(true);
  });

  it('does not mark counts as a floor when the read came in under the limit', async () => {
    const ledger = await computeSpecEnforcementRepeatedApproach(
      deps({ items: [item({ workItemId: 'WI-1' })], claims: [claim({ workItemId: 'WI-1' })] }),
      { itemLimit: 50 },
    );

    expect(ledger.rollup.bounded.countsAreFloor).toBe(false);
  });
});
