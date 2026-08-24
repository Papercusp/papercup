import { describe, expect, it } from 'vitest';
import {
  ESCAPE_NOT_DERIVABLE,
  ESCAPE_REWORK_GRACE_MS,
  computeSpecEnforcementEscape,
  type SpecEnforcementEscapeDeps,
} from './spec-enforcement-escape';
import type { FirstClaimRow, WorkItemLifecycleRow } from './spec-enforcement-latency';
import type { PlanAdoptionRow } from './spec-enforcement-eligibility';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const MIN = 60_000;

/** Typed factory, never a cast — see the note in spec-enforcement-latency.test.ts. */
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
  // Defaults describe a single, once-claimed item — the shape the ledger actually produces for
  // an item claimed exactly once. A typed literal (not a cast) so a future required field breaks
  // this file loudly instead of letting the fixture go quietly vacuous.
  return { firstWonAtMs: T0, lastWonAtMs: T0, wonClaimCount: 1, distinctClaimants: 1, ...over };
}

function plan(over: Partial<PlanAdoptionRow> & { planSlug: string }): PlanAdoptionRow {
  return { status: 'active', clauseCount: 3, legacyValSignal: false, ...over };
}

function deps(input: {
  items: WorkItemLifecycleRow[];
  claims?: FirstClaimRow[];
  plans?: PlanAdoptionRow[];
}): SpecEnforcementEscapeDeps {
  return {
    listWorkItemLifecycle: async () => ({ rows: input.items, observationsExcluded: 0 }),
    listWonClaims: async () => input.claims ?? [],
    listPlanAdoption: async () => input.plans ?? [],
  };
}

describe('computeSpecEnforcementEscape — what counts as an escape', () => {
  it('counts a won claim landing after the close', async () => {
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [item({ workItemId: 'WI-1', closedAtMs: T0 + 10 * MIN })],
        claims: [claim({ workItemId: 'WI-1', firstWonAtMs: T0, lastWonAtMs: T0 + 30 * MIN })],
      }),
    );

    expect(ledger.rollup.escapedItems).toBe(1);
    expect(ledger.rows[0]?.gapMs).toBe(20 * MIN);
    expect(ledger.rollup.escapesPerThousand).toBe(1000);
  });

  it('does NOT count a reclaim inside the grace window as rework', async () => {
    // Trailing bookkeeping in the closing transaction must not manufacture a defect.
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [item({ workItemId: 'WI-1', closedAtMs: T0 + 10 * MIN })],
        claims: [
          claim({
            workItemId: 'WI-1',
            lastWonAtMs: T0 + 10 * MIN + ESCAPE_REWORK_GRACE_MS - 1,
          }),
        ],
      }),
    );

    expect(ledger.rollup.escapedItems).toBe(0);
    expect(ledger.rollup.detectableItems).toBe(1);
    expect(ledger.rollup.escapesPerThousand).toBe(0);
  });

  it('does not count a claim that PRECEDES the close — the normal case', async () => {
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [item({ workItemId: 'WI-1', closedAtMs: T0 + 30 * MIN })],
        claims: [claim({ workItemId: 'WI-1', lastWonAtMs: T0 })],
      }),
    );
    expect(ledger.rollup.escapedItems).toBe(0);
  });
});

describe('computeSpecEnforcementEscape — the denominator is the instrument reach', () => {
  it('EXCLUDES a closed item with no ledger row instead of diluting the rate with it', async () => {
    // This is the measure's central honesty property. The unledgered item could have escaped
    // any number of times and this instrument would never see it, so counting it as a clean
    // observation would let ledger COVERAGE masquerade as quality.
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [
          item({ workItemId: 'WI-seen', closedAtMs: T0 + 10 * MIN }),
          item({ workItemId: 'WI-invisible-1', closedAtMs: T0 + 10 * MIN }),
          item({ workItemId: 'WI-invisible-2', closedAtMs: T0 + 10 * MIN }),
        ],
        claims: [claim({ workItemId: 'WI-seen', lastWonAtMs: T0 + 40 * MIN })],
      }),
    );

    expect(ledger.rollup.coverage.closedItems).toBe(3);
    expect(ledger.rollup.coverage.closedItemsOutsideLedgerReach).toBe(2);
    expect(ledger.rollup.detectableItems).toBe(1);
    // 1 escape / 1 detectable = 1000‰. Had the two invisible items diluted it, it would read 333‰
    // — a number that looks like a measurement and is an artifact of ledger coverage.
    expect(ledger.rollup.escapesPerThousand).toBe(1000);
  });

  it('reports an UNMEASURED rate as null, never as a clean zero', async () => {
    const ledger = await computeSpecEnforcementEscape(
      deps({ items: [item({ workItemId: 'WI-1', closedAtMs: null })] }),
    );

    expect(ledger.rollup.detectableItems).toBe(0);
    expect(ledger.rollup.escapesPerThousand).toBeNull();
  });

  it('ignores items that were never closed', async () => {
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [item({ workItemId: 'WI-open', status: 'open', closedAtMs: null })],
        claims: [claim({ workItemId: 'WI-open', lastWonAtMs: T0 + 99 * MIN })],
      }),
    );
    expect(ledger.rollup.coverage.closedItems).toBe(0);
    expect(ledger.rollup.escapedItems).toBe(0);
  });
});

describe('computeSpecEnforcementEscape — the enforcement partition', () => {
  it('splits escapes by plan eligibility and keeps unknown separate from not-enforced', async () => {
    const ledger = await computeSpecEnforcementEscape(
      deps({
        items: [
          item({ workItemId: 'WI-live', sourcePlanSlug: 'live', closedAtMs: T0 }),
          item({ workItemId: 'WI-old', sourcePlanSlug: 'old', closedAtMs: T0 }),
          item({ workItemId: 'WI-none', sourcePlanSlug: null, closedAtMs: T0 }),
        ],
        claims: [
          claim({ workItemId: 'WI-live', lastWonAtMs: T0 + 30 * MIN }),
          claim({ workItemId: 'WI-old', lastWonAtMs: T0 }),
          claim({ workItemId: 'WI-none', lastWonAtMs: T0 + 30 * MIN }),
        ],
        plans: [plan({ planSlug: 'live', status: 'active' }), plan({ planSlug: 'old', status: 'shipped' })],
      }),
    );

    expect(ledger.rollup.byEnforcement.enforced).toEqual({ detectable: 1, escaped: 1 });
    expect(ledger.rollup.byEnforcement['not-enforced']).toEqual({ detectable: 1, escaped: 0 });
    expect(ledger.rollup.byEnforcement.unattributed).toEqual({ detectable: 1, escaped: 1 });
  });
});

describe('computeSpecEnforcementEscape — declared blind spots', () => {
  it('states that a reopened-then-reclosed item is invisible to the snapshot signal', async () => {
    const ledger = await computeSpecEnforcementEscape(deps({ items: [] }));
    const gap = ledger.rollup.notDerivable.find((m) => m.measure === 'reopened-then-reclosed items');

    expect(gap).toBeDefined();
    expect(gap?.reason).toMatch(/terminal_owner/);
    // Both known blind spots are declared, so a reader cannot mistake the measure for complete.
    expect(ESCAPE_NOT_DERIVABLE).toHaveLength(2);
  });

  it('states that later defects citing a closed item are not counted', async () => {
    const ledger = await computeSpecEnforcementEscape(deps({ items: [] }));
    expect(
      ledger.rollup.notDerivable.some((m) => m.measure === 'defects filed later citing a closed item'),
    ).toBe(true);
  });
});

describe('computeSpecEnforcementEscape — falsifiability control', () => {
  it('CONTROL: including unledgered items would move the pinned rate from 1000 to 333', () => {
    // The wrong implementation, computed inline: 1 escape over a denominator that includes the
    // two items the instrument cannot see. The pinned expectation above (1000) is therefore
    // discriminating — it would fail under the diluted denominator.
    const diluted = Math.round((1 / 3) * 1000);
    expect(diluted).toBe(333);
    expect(diluted).not.toBe(1000);
  });
});
