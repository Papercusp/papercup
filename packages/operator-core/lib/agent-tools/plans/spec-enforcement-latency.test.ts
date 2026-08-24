import { describe, expect, it } from 'vitest';
import {
  LATENCY_NOT_DERIVABLE,
  computeSpecEnforcementLatency,
  type FirstClaimRow,
  type SpecEnforcementLatencyDeps,
  type WorkItemLifecycleRow,
} from './spec-enforcement-latency';
import type { PlanAdoptionRow } from './spec-enforcement-eligibility';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const MIN = 60_000;

/**
 * Typed factories, deliberately NOT `{ … } as WorkItemLifecycleRow`.
 *
 * A cast would let a fixture omit a field the reader type declares, which is exactly how a
 * partition goes vacuous while still looking populated: the census reads `undefined`, buckets
 * everything under one key, and tsc stays silent because the cast asserted the shape was fine.
 * With a real typed parameter, adding a required field to the reader breaks every fixture here
 * until it supplies one — which is the protection, not an inconvenience.
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

function plan(over: Partial<PlanAdoptionRow> & { planSlug: string }): PlanAdoptionRow {
  return { status: 'active', clauseCount: 3, legacyValSignal: false, ...over };
}

function deps(input: {
  items: WorkItemLifecycleRow[];
  /** Observations the READER already excluded in SQL, as the production reader does. */
  observationsExcluded?: number;
  claims?: FirstClaimRow[];
  plans?: PlanAdoptionRow[];
}): SpecEnforcementLatencyDeps {
  return {
    listWorkItemLifecycle: async () => ({
      rows: input.items,
      observationsExcluded: input.observationsExcluded ?? 0,
    }),
    listFirstClaims: async () => input.claims ?? [],
    listPlanAdoption: async () => input.plans ?? [],
  };
}

describe('computeSpecEnforcementLatency — the enforcement partition', () => {
  it('splits items by their plan eligibility instead of reporting one pooled median', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({ workItemId: 'WI-1', sourcePlanSlug: 'live', takenAtMs: T0, closedAtMs: T0 + 10 * MIN }),
          item({ workItemId: 'WI-2', sourcePlanSlug: 'old', takenAtMs: T0, closedAtMs: T0 + 90 * MIN }),
        ],
        plans: [plan({ planSlug: 'live', status: 'active' }), plan({ planSlug: 'old', status: 'shipped' })],
      }),
    );

    expect(ledger.rollup.byEnforcement.enforced.claimToCompletion.n).toBe(1);
    expect(ledger.rollup.byEnforcement.enforced.claimToCompletion.p50Ms).toBe(10 * MIN);
    expect(ledger.rollup.byEnforcement['not-enforced'].claimToCompletion.n).toBe(1);
    expect(ledger.rollup.byEnforcement['not-enforced'].claimToCompletion.p50Ms).toBe(90 * MIN);
  });

  it('CALIBRATION: the split is not an artifact — identical items on identical plans land together', async () => {
    // Without this control, a bucket assignment that ignored its input entirely would still
    // pass the test above by coincidence of ordering.
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({ workItemId: 'WI-1', sourcePlanSlug: 'live', takenAtMs: T0, closedAtMs: T0 + MIN }),
          item({ workItemId: 'WI-2', sourcePlanSlug: 'live', takenAtMs: T0, closedAtMs: T0 + MIN }),
        ],
        plans: [plan({ planSlug: 'live' })],
      }),
    );
    expect(ledger.rollup.byEnforcement.enforced.items).toBe(2);
    expect(ledger.rollup.byEnforcement['not-enforced'].items).toBe(0);
    expect(ledger.rollup.byEnforcement.unattributed.items).toBe(0);
  });

  it('keeps an unresolvable plan UNATTRIBUTED rather than folding it into not-enforced', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({ workItemId: 'WI-1', sourcePlanSlug: null, takenAtMs: T0, closedAtMs: T0 + MIN }),
          item({ workItemId: 'WI-2', sourcePlanSlug: 'missing-from-census', takenAtMs: T0, closedAtMs: T0 + MIN }),
        ],
        plans: [plan({ planSlug: 'unrelated' })],
      }),
    );

    expect(ledger.rollup.byEnforcement.unattributed.items).toBe(2);
    expect(ledger.rollup.byEnforcement['not-enforced'].items).toBe(0);
    expect(ledger.rows.every((r) => r.bucket === 'unattributed')).toBe(true);
    // An unattributed row has no plan to classify, so it must not invent a lane/adoption.
    expect(ledger.rows.every((r) => r.lane === null && r.adoption === null)).toBe(true);
  });
});

describe('computeSpecEnforcementLatency — claim instant provenance', () => {
  it('PREFERS the append-only ledger over taken_at, which the claim path overwrites', async () => {
    // The reclaim case: the ledger holds the FIRST claim at T0, while the column has been
    // moved forward to T0+60min by a later reclaim. Measuring from the column would report a
    // 30-minute item for work that actually took 90.
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [item({ workItemId: 'WI-1', takenAtMs: T0 + 60 * MIN, closedAtMs: T0 + 90 * MIN })],
        claims: [{ workItemId: 'WI-1', firstWonAtMs: T0, lastWonAtMs: T0 }],
      }),
    );

    expect(ledger.rows[0]?.claimToCompletionMs).toBe(90 * MIN);
    expect(ledger.rows[0]?.claimInstantSource).toBe('claim-ledger');
    expect(ledger.rollup.byClaimInstantSource['claim-ledger']).toBe(1);
    expect(ledger.rollup.byClaimInstantSource['taken-at-column']).toBe(0);
  });

  it('STAMPS the fallback when no ledger row exists, so it cannot read as ledger-backed', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({ items: [item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: T0 + 30 * MIN })] }),
    );

    expect(ledger.rows[0]?.claimInstantSource).toBe('taken-at-column');
    expect(ledger.rollup.byClaimInstantSource['taken-at-column']).toBe(1);
    expect(ledger.rollup.byClaimInstantSource['claim-ledger']).toBe(0);
  });
});

describe('computeSpecEnforcementLatency — exclusions are counted, never silent', () => {
  it("counts lane='observation' rows the reader excluded in SQL", async () => {
    // The production path: the reader pre-filters (they are 62% of the table) and reports how
    // many it dropped, so the exclusion is visible without being transported.
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: T0 + MIN })],
        observationsExcluded: 59_188,
      }),
    );

    expect(ledger.rollup.itemsMeasured).toBe(1);
    expect(ledger.rollup.excluded.observations).toBe(59_188);
  });

  it('DEFENSIVE: still drops observation rows an injected reader failed to pre-filter', async () => {
    // A reader that does not pre-filter must not be able to poison the distributions. Without
    // this second filter, the 999-minute notes below would dominate every percentile.
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: T0 + MIN }),
          item({ workItemId: 'OBS-1', lane: 'observation', takenAtMs: T0, closedAtMs: T0 + 999 * MIN }),
          item({ workItemId: 'OBS-2', lane: 'observation', takenAtMs: T0, closedAtMs: T0 + 999 * MIN }),
        ],
      }),
    );

    expect(ledger.rollup.itemsMeasured).toBe(1);
    expect(ledger.rollup.excluded.observations).toBe(2);
    // The excluded rows must not have reached any distribution.
    expect(ledger.rollup.byEnforcement.unattributed.claimToCompletion.maxMs).toBe(MIN);
  });

  it('excludes a never-claimed item instead of treating absence as a zero-length claim', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({ workItemId: 'WI-1', takenAtMs: null, closedAtMs: T0 + MIN }),
          item({ workItemId: 'WI-2', takenAtMs: T0, closedAtMs: T0 + 10 * MIN }),
        ],
      }),
    );

    expect(ledger.rollup.excluded.neverClaimed).toBe(1);
    expect(ledger.rollup.itemsMeasured).toBe(1);
    expect(ledger.rollup.byEnforcement.unattributed.claimToCompletion.p50Ms).toBe(10 * MIN);
  });

  it('drops a negative duration rather than clamping it to 0 and faking a fastest observation', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          // closed BEFORE the recorded claim — a reclaim moved taken_at past an earlier close.
          item({ workItemId: 'WI-bad', takenAtMs: T0 + 50 * MIN, closedAtMs: T0 }),
          item({ workItemId: 'WI-ok', takenAtMs: T0, closedAtMs: T0 + 20 * MIN }),
        ],
      }),
    );

    expect(ledger.rollup.excluded.negativeDuration).toBe(1);
    // If the negative had been clamped to 0 it would become the p50 of a 2-sample set.
    expect(ledger.rollup.byEnforcement.unattributed.claimToCompletion.n).toBe(1);
    expect(ledger.rollup.byEnforcement.unattributed.claimToCompletion.p50Ms).toBe(20 * MIN);
  });
});

describe('computeSpecEnforcementLatency — units, distribution and boundedness', () => {
  it('reports durations in MILLISECONDS, not the seconds a mixed-unit join would produce', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({ items: [item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: T0 + 90 * MIN })] }),
    );
    // 90 minutes is 5,400,000 ms. A closed_ts read as seconds would yield 5,400.
    expect(ledger.rows[0]?.claimToCompletionMs).toBe(5_400_000);
  });

  it('computes nearest-rank percentiles over a known sample', async () => {
    const items = [10, 20, 30, 40, 100].map((m, i) =>
      item({ workItemId: `WI-${i}`, takenAtMs: T0, closedAtMs: T0 + m * MIN }),
    );
    const ledger = await computeSpecEnforcementLatency(deps({ items }));
    const d = ledger.rollup.byEnforcement.unattributed.claimToCompletion;

    expect(d.n).toBe(5);
    expect(d.p50Ms).toBe(30 * MIN);
    expect(d.p90Ms).toBe(100 * MIN);
    expect(d.maxMs).toBe(100 * MIN);
  });

  it('reports an EMPTY distribution as n=0 with null percentiles, never as a zero duration', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({ items: [item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: null })] }),
    );
    const d = ledger.rollup.byEnforcement.unattributed.claimToCompletion;

    expect(d.n).toBe(0);
    expect(d.p50Ms).toBeNull();
    expect(d.maxMs).toBeNull();
    // The item is still counted as present — absent duration, not absent item.
    expect(ledger.rollup.byEnforcement.unattributed.items).toBe(1);
  });

  it('marks counts as a FLOOR when the item limit truncated the read', async () => {
    const items = [0, 1, 2].map((i) => item({ workItemId: `WI-${i}`, takenAtMs: T0, closedAtMs: T0 + MIN }));
    const ledger = await computeSpecEnforcementLatency(deps({ items }), { itemLimit: 3 });

    expect(ledger.rollup.bounded.truncatedByItemLimit).toBe(true);
    expect(ledger.rollup.bounded.countsAreFloor).toBe(true);
  });

  it('does NOT mark a floor when the read came back under the limit', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({ items: [item({ workItemId: 'WI-1', takenAtMs: T0, closedAtMs: T0 + MIN })] }),
      { itemLimit: 50 },
    );
    expect(ledger.rollup.bounded.countsAreFloor).toBe(false);
  });
});

describe('computeSpecEnforcementLatency — falsifiability controls', () => {
  /**
   * Nearest-rank percentile, reimplemented here as a CONTROL.
   *
   * The repo's mutation-probe guidance for a subject you `import` is to keep a deliberately-
   * wrong implementation permanently in the test file rather than mutating the shared tree.
   * These two cases are that control: they show the exact numbers the suite asserts above are
   * DISCRIMINATING — that a plausible wrong implementation produces a different value and would
   * therefore be caught. Without them, an assertion like `p50Ms === 20 * MIN` could be passing
   * because the guard works or because the sample happens to land there either way.
   */
  function nearestRank(samples: readonly number[], fraction: number): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? null;
  }

  it('CONTROL: clamping a negative to 0 would move the asserted p50 — so that assertion can fail', () => {
    // The real subject DROPS the negative, leaving one sample.
    expect(nearestRank([20 * MIN], 0.5)).toBe(20 * MIN);
    // A clamping implementation would keep it as a 0-length observation, halving the p50 to 0.
    expect(nearestRank([0, 20 * MIN], 0.5)).toBe(0);
    // The two differ ⇒ the negative-duration test above is falsifiable, not incidentally true.
    expect(nearestRank([20 * MIN], 0.5)).not.toBe(nearestRank([0, 20 * MIN], 0.5));
  });

  it('CONTROL: folding unattributed into not-enforced would move a count the suite pins', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [item({ workItemId: 'WI-1', sourcePlanSlug: null, takenAtMs: T0, closedAtMs: T0 + MIN })],
        plans: [plan({ planSlug: 'unrelated' })],
      }),
    );
    // The wrong implementation would report not-enforced=1/unattributed=0; the right one the
    // reverse. Pinning BOTH sides means neither can drift without a failure.
    expect(ledger.rollup.byEnforcement.unattributed.items).toBe(1);
    expect(ledger.rollup.byEnforcement['not-enforced'].items).toBe(0);
  });
});

describe('computeSpecEnforcementLatency — the undeliverable measure is declared, not approximated', () => {
  it('states claim-to-first-checkpoint as not derivable rather than aliasing last-progress to it', async () => {
    const ledger = await computeSpecEnforcementLatency(deps({ items: [] }));
    const gap = ledger.rollup.notDerivable.find((m) => m.measure === 'claim-to-first-checkpoint');

    expect(gap).toBeDefined();
    expect(gap?.reason).toMatch(/last_progress_at/);
    expect(LATENCY_NOT_DERIVABLE).toHaveLength(1);
  });

  it('reports last-progress under its own name, distinct from completion', async () => {
    const ledger = await computeSpecEnforcementLatency(
      deps({
        items: [
          item({
            workItemId: 'WI-1',
            takenAtMs: T0,
            lastProgressAtMs: T0 + 5 * MIN,
            closedAtMs: T0 + 40 * MIN,
          }),
        ],
      }),
    );

    expect(ledger.rows[0]?.claimToLastProgressMs).toBe(5 * MIN);
    expect(ledger.rows[0]?.claimToCompletionMs).toBe(40 * MIN);
  });
});
