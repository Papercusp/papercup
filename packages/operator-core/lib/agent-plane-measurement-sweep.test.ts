import { describe, it, expect } from 'vitest';
import {
  composeCounts,
  planeMeasurementSweep,
  formatMeasurementLog,
  PLANE_MEASUREMENT_INTERVAL_MS,
  CLARIFICATION_TOOLS,
  ENRICHED_SURFACES,
} from './agent-plane-measurement-sweep';
import { composePlaneMeasurement } from './agent-plane-measurement';
import type { DivergenceReport, DivergenceCoverage } from './agent-state-divergence';

function coverage(over: Partial<DivergenceCoverage> = {}): DivergenceCoverage {
  return {
    callsExamined: 0,
    stampedCalls: 0,
    goalStampedCalls: 0,
    stampFillRate: 0,
    intentBuckets: 0,
    comparableBuckets: 0,
    failuresSeen: 0,
    thrashRuns: 0,
    stampedLegRan: false,
    samplingLegRan: false,
    ...over,
  };
}

function report(over: Partial<DivergenceReport> = {}): DivergenceReport {
  return { divergences: [], truncated: false, coverage: coverage(), structuralZero: null, ...over };
}

const NO_CALLS = {
  calls: 0,
  attributed: 0,
  clarification_calls: 0,
  enriched_calls: 0,
  enriched_sized: 0,
  enriched_bytes: 0,
};
const NO_FACTS = { live_facts: 0, with_deps: 0 };

describe('composeCounts consumes the divergence report (D-038 axis 5)', () => {
  it('takes callsExamined from the REPORT, never from its own aggregate', () => {
    // The two reads run at slightly different instants, so they legitimately
    // disagree. The measurement must describe the window the DETECTOR examined —
    // otherwise the rate and its denominator come from two different derivations.
    const counts = composeCounts({
      divergence: report({ coverage: coverage({ callsExamined: 1234 }) }),
      calls: { ...NO_CALLS, calls: 9999 },
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    expect(counts['intent-action-divergence-sampling'].population).toBe(1234);
    expect(counts['intent-action-divergence-stamped'].population).toBe(1234);
  });

  it('maps the sampling leg to D-091’s thrashRuns / failuresSeen denominator', () => {
    const counts = composeCounts({
      divergence: report({ coverage: coverage({ callsExamined: 176_784, failuresSeen: 601, thrashRuns: 39 }) }),
      calls: NO_CALLS,
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    const sampling = counts['intent-action-divergence-sampling'];
    expect(sampling.comparable).toBe(601);
    expect(sampling.observed).toBe(39);
  });

  it('maps the stamped leg to stampedCalls (fill) and comparableBuckets (verdict)', () => {
    const counts = composeCounts({
      divergence: report({
        coverage: coverage({ callsExamined: 1000, stampedCalls: 250, comparableBuckets: 12 }),
        divergences: [
          { kind: 'goal-drift-within-intent', ownerId: 'a', intentEventId: 1, detail: 'd', a: {} as never, b: {} as never },
          { kind: 'unconverged-retry-loop', ownerId: 'b', intentEventId: null, detail: 'd', a: {} as never, b: {} as never },
        ],
      }),
      calls: NO_CALLS,
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    const stamped = counts['intent-action-divergence-stamped'];
    expect(stamped.eligible).toBe(250);
    expect(stamped.comparable).toBe(12);
    // Only the goal-drift finding belongs to this leg.
    expect(stamped.observed).toBe(1);
  });

  it('survives a null report without inventing numbers', () => {
    const counts = composeCounts({
      divergence: null,
      calls: { ...NO_CALLS, calls: 42, attributed: 40 },
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    expect(counts['intent-action-divergence-sampling'].population).toBe(42);
    expect(counts['intent-action-divergence-sampling'].comparable).toBe(0);
  });
});

describe('composeCounts — the fact-backed and cost metrics', () => {
  it('counts clarification against every attributed call', () => {
    const counts = composeCounts({
      divergence: null,
      calls: { ...NO_CALLS, calls: 1000, attributed: 900, clarification_calls: 16 },
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    const c = counts['clarification-rate'];
    expect(c.population).toBe(1000);
    expect(c.eligible).toBe(900);
    expect(c.comparable).toBe(900);
    expect(c.observed).toBe(16);
  });

  it('reports the staleness metric as UNCOMPARABLE when the verdict leg did not run', () => {
    // The leg is injected and absent by default. With facts carrying dependsOn but
    // no verdict, the honest reading is "could not compare" — never a rate.
    const counts = composeCounts({
      divergence: null,
      calls: NO_CALLS,
      facts: { live_facts: 2148, with_deps: 7 },
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 })
      .metrics.find((x) => x.id === 'acted-on-stale-or-wrong-value')!;
    expect(m.eligible).toBe(7);
    expect(m.comparable).toBe(0);
    expect(m.rate).toBeNull();
    expect(m.zeroReason).toBe('nothing-comparable');
  });

  it('excludes undeterminable verdicts from the staleness denominator', () => {
    const counts = composeCounts({
      divergence: null,
      calls: NO_CALLS,
      facts: { live_facts: 100, with_deps: 10 },
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      // 10 eligible, but only 6 produced a usable verdict; 2 of those are stale.
      staleness: { determinable: 6, stale: 2 },
    });
    const m = counts['acted-on-stale-or-wrong-value'];
    expect(m.eligible).toBe(10);
    expect(m.comparable).toBe(6);
    expect(m.observed).toBe(2);
  });

  it('token cost reports BYTES over enriched CALLS — the pre-enrichment baseline', () => {
    const counts = composeCounts({
      divergence: null,
      calls: { ...NO_CALLS, calls: 500, enriched_calls: 120, enriched_sized: 118, enriched_bytes: 1_000_000 },
      facts: NO_FACTS,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 })
      .metrics.find((x) => x.id === 'plane-token-cost')!;
    expect(m.comparable).toBe(118);
    expect(m.observed).toBe(1_000_000);
    expect(m.rate).toBeCloseTo(8474.576, 2); // mean bytes per enriched call
    expect(m.verdictUnit).toBe('output byte');
  });

  it('coerces postgres string counts', () => {
    const counts = composeCounts({
      divergence: null,
      calls: { ...NO_CALLS, calls: '77', attributed: '70', clarification_calls: '3' } as never,
      facts: { live_facts: '2148', with_deps: '0' } as never,
      assumptionsExamined: 0,
      comparedPairs: 0,
      conflicts: 0,
      staleness: null,
    });
    expect(counts['clarification-rate'].population).toBe(77);
    expect(counts['conflicting-assumption-incidence'].population).toBe(2148);
  });
});

describe('planeMeasurementSweep', () => {
  const stubs = {
    loadCallAggregates: async () => NO_CALLS,
    loadFactAggregates: async () => NO_FACTS,
    listAssumptionFacts: async () => [],
  } as const;

  it('records one reading and returns it', async () => {
    const recorded: unknown[] = [];
    const out = await planeMeasurementSweep({
      ...stubs,
      lastMeasuredAtMs: async () => null,
      recordMeasurement: async (m: unknown) => void recorded.push(m),
      divergence: report({ coverage: coverage({ callsExamined: 10, failuresSeen: 2, thrashRuns: 1 }) }),
    } as never);
    expect(out.outcome).toBe('recorded');
    expect(recorded).toHaveLength(1);
  });

  it('records at most one reading per window', async () => {
    const now = Date.now();
    const out = await planeMeasurementSweep({
      ...stubs,
      now,
      lastMeasuredAtMs: async () => now - 60_000,
      recordMeasurement: async () => {
        throw new Error('must not record');
      },
    } as never);
    expect(out.outcome).toBe('skipped');
    expect(PLANE_MEASUREMENT_INTERVAL_MS).toBeGreaterThan(60_000);
  });

  it('records again once the window has elapsed', async () => {
    const now = Date.now();
    const out = await planeMeasurementSweep({
      ...stubs,
      now,
      lastMeasuredAtMs: async () => now - PLANE_MEASUREMENT_INTERVAL_MS - 1,
      recordMeasurement: async () => {},
    } as never);
    expect(out.outcome).toBe('recorded');
  });

  it('is FAIL-SOFT — a failing read never throws into the tick', async () => {
    const out = await planeMeasurementSweep({
      ...stubs,
      lastMeasuredAtMs: async () => null,
      loadCallAggregates: async () => {
        throw new Error('pg down');
      },
      recordMeasurement: async () => {},
    } as never);
    expect(out.outcome).toBe('error');
    if (out.outcome === 'error') expect(out.reason).toContain('pg down');
  });
});

describe('formatMeasurementLog', () => {
  it('names the missing PRODUCER instead of printing a clean-looking zero', () => {
    const m = composePlaneMeasurement({
      counts: composeCounts({
        divergence: report({ coverage: coverage({ callsExamined: 176_784 }) }),
        calls: NO_CALLS,
        facts: { live_facts: 2148, with_deps: 0 },
        assumptionsExamined: 0,
        comparedPairs: 0,
        conflicts: 0,
        staleness: null,
      }),
      windowStartMs: 0,
      windowEndMs: 1,
    });
    const line = formatMeasurementLog(m);
    expect(line).toContain('UNMEASURED');
    expect(line).toContain('nothing-eligible');
    expect(line).toContain('awaiting');
    // The failure this whole item exists to prevent: a log line that reads as
    // "no divergence, no conflicts" when in fact nothing was measured.
    expect(line).not.toMatch(/=0\/0 \(0\)/);
  });
});

describe('the measured surface lists', () => {
  it('matches clarification verbs exactly — no substring sweep-in', () => {
    expect(CLARIFICATION_TOOLS).toContain('coord:ask');
    expect(CLARIFICATION_TOOLS).toContain('coord:ask-owner');
    // `work_items:request_release` also "asks" — it must not be counted.
    expect(CLARIFICATION_TOOLS as readonly string[]).not.toContain('work_items:request_release');
  });

  it('covers the surfaces this plane enriches', () => {
    for (const t of ['coord:orient', 'work_items:list', 'work_items:get', 'locks:queue']) {
      expect(ENRICHED_SURFACES as readonly string[]).toContain(t);
    }
  });
});
