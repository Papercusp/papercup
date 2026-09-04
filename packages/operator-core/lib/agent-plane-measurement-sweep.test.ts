import { describe, it, expect } from 'vitest';
import {
  composeCounts,
  planeMeasurementSweep,
  formatMeasurementLog,
  reduceCommitmentBasis,
  PLANE_MEASUREMENT_INTERVAL_MS,
  CLARIFICATION_TOOLS,
  ENRICHED_SURFACES,
  type CommitmentBasisRow,
} from './agent-plane-measurement-sweep';
import { composePlaneMeasurement } from './agent-plane-measurement';
import type { DivergenceReport, DivergenceCoverage } from './agent-state-divergence';

function coverage(over: Partial<DivergenceCoverage> = {}): DivergenceCoverage {
  const base: DivergenceCoverage = {
    callsExamined: 0,
    stampedCalls: 0,
    goalStampedCalls: 0,
    stampFillRate: 0,
    intentBuckets: 0,
    comparableBuckets: 0,
    failuresSeen: 0,
    thrashRuns: 0,
    convergedRuns: 0,
    unsettledRuns: 0,
    stampedLegRan: false,
    samplingLegRan: false,
    // P-010's terminal-goal filter. `terminalFilterApplied: false` is the correct
    // default for a bare fixture: it means "no filter ran", which is what a
    // constructed coverage object with no goal state actually represents.
    terminalFilterApplied: false,
    terminalGoalCallsExcluded: 0,
    bucketsCollapsedByTerminal: 0,
    launchOutcomeCalls: 0,
    launchFailuresReconciled: 0,
  };
  // Annotate the defaults, THEN merge — spreading a Partial<T> directly into an
  // object literal that must satisfy T re-widens every overridable field to
  // `T[k] | undefined`, which does not assign back to T.
  return { ...base, ...over };
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
const NO_STALE_QUOTES = { messages: 0, detected_quotes: 0, comparable_quotes: 0, stale_quotes: 0 };

describe('composeCounts consumes the divergence report (D-038 axis 5)', () => {
  it('takes callsExamined from the REPORT, never from its own aggregate', () => {
    // The two reads run at slightly different instants, so they legitimately
    // disagree. The measurement must describe the window the DETECTOR examined —
    // otherwise the rate and its denominator come from two different derivations.
    const counts = composeCounts({
      divergence: report({ coverage: coverage({ callsExamined: 1234 }) }),
      calls: { ...NO_CALLS, calls: 9999 },
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
    });
    expect(counts['intent-action-divergence-sampling'].population).toBe(1234);
    expect(counts['intent-action-divergence-stamped'].population).toBe(1234);
  });

  it('maps the sampling leg to D-091’s thrashRuns / failuresSeen denominator', () => {
    const counts = composeCounts({
      divergence: report({ coverage: coverage({ callsExamined: 176_784, failuresSeen: 601, thrashRuns: 39 }) }),
      calls: NO_CALLS,
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
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
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
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
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
    });
    expect(counts['intent-action-divergence-sampling'].population).toBe(42);
    expect(counts['intent-action-divergence-sampling'].comparable).toBe(0);
  });
});

describe('composeCounts — the stale-quote and cost metrics', () => {
  it('counts clarification against every attributed call', () => {
    const counts = composeCounts({
      divergence: null,
      calls: { ...NO_CALLS, calls: 1000, attributed: 900, clarification_calls: 16 },
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
    });
    const c = counts['clarification-rate'];
    expect(c.population).toBe(1000);
    expect(c.eligible).toBe(900);
    expect(c.comparable).toBe(900);
    expect(c.observed).toBe(16);
  });

  it('reports the stale-action metric as UNCOMPARABLE when detected stamps carry no verdict', () => {
    const counts = composeCounts({
      divergence: null,
      calls: NO_CALLS,
      staleQuotes: { messages: 2148, detected_quotes: 7, comparable_quotes: 0, stale_quotes: 0 },
      commitmentBasis: null,
    });
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 })
      .metrics.find((x) => x.id === 'acted-on-stale-or-wrong-value')!;
    expect(m.eligible).toBe(7);
    expect(m.comparable).toBe(0);
    expect(m.rate).toBeNull();
    expect(m.zeroReason).toBe('nothing-comparable');
  });

  it('counts only declared send-time verdicts in the stale-action denominator', () => {
    const counts = composeCounts({
      divergence: null,
      calls: NO_CALLS,
      // 10 detected citations, but only 6 carry a recognized verdict; 2 lacked a fresh read.
      staleQuotes: { messages: 100, detected_quotes: 10, comparable_quotes: 6, stale_quotes: 2 },
      commitmentBasis: null,
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
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
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
      staleQuotes: { messages: '2148', detected_quotes: '7', comparable_quotes: '6', stale_quotes: '2' } as never,
      commitmentBasis: null,
    });
    expect(counts['clarification-rate'].population).toBe(77);
    expect(counts['acted-on-stale-or-wrong-value'].population).toBe(2148);
  });
});

describe('planeMeasurementSweep', () => {
  const stubs = {
    loadCallAggregates: async () => NO_CALLS,
    loadStaleQuoteAggregates: async () => NO_STALE_QUOTES,
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
        staleQuotes: NO_STALE_QUOTES,
        commitmentBasis: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// The commitment-backed legs (WI-6465 / D-102)
// ─────────────────────────────────────────────────────────────────────────────

function row(over: Partial<CommitmentBasisRow> = {}): CommitmentBasisRow {
  return {
    condition_at_close: 'live',
    pinned_version: '100',
    current_version: '100',
    retracted_now: false,
    expired_now: false,
    ...over,
  };
}

const TOTALS = { closes_declaring: 284, closes_naming_keys: 29 };

describe('reduceCommitmentBasis', () => {
  it('separates "stale when cited" from "moved since" — they are different defects', () => {
    const counts = reduceCommitmentBasis(
      [
        row(), // live then, unchanged now
        row({ current_version: '101' }), // live when cited, revised since
        row({ condition_at_close: 'superseded' }), // ALREADY stale when cited
      ],
      TOTALS,
    );
    // Only the third was the closer's problem; only the second is a re-check.
    expect(counts.staleAtClose).toBe(1);
    expect(counts.movedSince).toBe(1);
    expect(counts.comparableAtClose).toBe(3);
    expect(counts.comparableNow).toBe(3);
  });

  it('reads bigint version ids arriving as STRINGS from postgres', () => {
    // node-postgres returns bigint as text; a numeric comparison against a string
    // would make '99' > '100' and report a phantom supersede.
    expect(reduceCommitmentBasis([row({ pinned_version: '99', current_version: '100' })], TOTALS).movedSince).toBe(1);
    expect(reduceCommitmentBasis([row({ pinned_version: '100', current_version: '100' })], TOTALS).movedSince).toBe(0);
  });

  it('treats an unparseable version as NO PIN, never as version 0', () => {
    // Version 0 does not exist, and coercing to it would compare as superseded
    // against every real row — a fleet-wide phantom finding.
    const counts = reduceCommitmentBasis([row({ pinned_version: 'not-a-number' })], TOTALS);
    expect(counts.comparableNow).toBe(0);
    expect(counts.movedSince).toBe(0);
  });

  it('excludes an unreadable close-time condition from BOTH sides of the rate', () => {
    const counts = reduceCommitmentBasis(
      [row({ condition_at_close: 'unresolved' }), row({ condition_at_close: null })],
      TOTALS,
    );
    expect(counts.comparableAtClose).toBe(0);
    expect(counts.staleAtClose).toBe(0);
  });

  it('carries the declaration totals through as the population and fill numerator', () => {
    // The ~90% of closes answering the literal 'none' must stay in the
    // population: dropping them would flatter the rate by measuring only the
    // agents who opted in to being measured.
    const counts = reduceCommitmentBasis([], TOTALS);
    expect(counts.closesDeclaring).toBe(284);
    expect(counts.closesNamingKeys).toBe(29);
  });

  it('never reports more observed than comparable', () => {
    const rows = [
      row(),
      row({ current_version: '101' }),
      row({ retracted_now: true }),
      row({ expired_now: true }),
      row({ current_version: null }),
      row({ pinned_version: null }),
      row({ condition_at_close: 'unresolved' }),
      row({ condition_at_close: 'lapsed' }),
    ];
    const counts = reduceCommitmentBasis(rows, TOTALS);
    expect(counts.staleAtClose).toBeLessThanOrEqual(counts.comparableAtClose);
    expect(counts.movedSince).toBeLessThanOrEqual(counts.comparableNow);
    expect(counts.comparableNow).toBeLessThanOrEqual(rows.length);
  });
});

describe('the commitment legs reach the composed metrics', () => {
  const counts = composeCounts({
    divergence: null,
    calls: NO_CALLS,
    staleQuotes: NO_STALE_QUOTES,
    commitmentBasis: {
      closesDeclaring: 284,
      closesNamingKeys: 29,
      comparableAtClose: 30,
      staleAtClose: 0,
      comparableNow: 30,
      movedSince: 5,
    },
  });

  it('gives the close-time leg a REAL denominator with an honest clean zero', () => {
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 });
    const leg = m.metrics.find((x) => x.id === 'acted-on-stale-declared-basis');
    expect(leg?.comparable).toBe(30);
    expect(leg?.observed).toBe(0);
    // The whole point of WI-6465: this used to be `nothing-eligible` (unbuilt).
    // Over a real denominator a defect-count zero is 'clean' and interpretable.
    expect(leg?.zeroReason).toBe('clean');
    expect(leg?.interpretable).toBe(true);
    expect(m.awaitingProducer).not.toContain('acted-on-stale-declared-basis');
  });

  it('reports the movement leg as a rate, not a structural zero', () => {
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 });
    const leg = m.metrics.find((x) => x.id === 'closed-work-basis-moved');
    expect(leg?.observed).toBe(5);
    expect(leg?.rate).toBeCloseTo(5 / 30, 4);
    expect(leg?.zeroReason).toBeNull();
    expect(leg?.interpretable).toBe(true);
  });

  it('fillRate exposes that only ~10% of closes name a basis at all', () => {
    const m = composePlaneMeasurement({ counts, windowStartMs: 0, windowEndMs: 1 });
    const leg = m.metrics.find((x) => x.id === 'acted-on-stale-declared-basis');
    expect(leg?.fillRate).toBeCloseTo(29 / 284, 4);
  });

  it('degrades to nothing-comparable — never a clean zero — when the loader fails', () => {
    // The sweep catches a loader fault and passes null. That must read as "not
    // measured", not as "no closed work rests on shifted ground".
    const nullCounts = composeCounts({
      divergence: null,
      calls: NO_CALLS,
      staleQuotes: NO_STALE_QUOTES,
      commitmentBasis: null,
    });
    const m = composePlaneMeasurement({ counts: nullCounts, windowStartMs: 0, windowEndMs: 1 });
    for (const id of ['acted-on-stale-declared-basis', 'closed-work-basis-moved'] as const) {
      const leg = m.metrics.find((x) => x.id === id);
      expect(leg?.zeroReason).not.toBe('clean');
      expect(leg?.interpretable).toBe(false);
    }
  });
});
