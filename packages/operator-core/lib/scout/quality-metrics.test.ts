/**
 * quality-metrics.test.ts — Scout standing quality metrics (scout-loop-test-plan
 * P-015) unit tests. Hermetic + $0: pure-core math over fixture snapshots, the
 * degradation tolerance edges (at-tolerance / past-tolerance / missing
 * baseline), and the composed check's injected capture port (fires exactly once
 * per breach set, stable title).
 */

import { describe, it, expect, vi } from 'vitest';
import type { RoutedIdeaProvenance, LensOutcomeReport } from './outcome-feedback';
import type { ScoutTickRecord } from './tick-ledger';
import { CREATIVE_LENSES, type CreativeLens } from './types';
import {
  computeScoutQualityReport,
  evaluateQualityDegradation,
  checkAndFlagQuality,
  qualityBreachTitle,
  SCOUT_TICK_GATES,
  DEFAULT_QUALITY_TOLERANCES,
  type ScoutQualityInputs,
  type ScoutQualityReport,
  type QualityCaptureRequest,
} from './quality-metrics';

// ── fixtures ──────────────────────────────────────────────────────────────────

function tick(p: Partial<ScoutTickRecord> & { status: ScoutTickRecord['status'] }): ScoutTickRecord {
  return { ...p };
}

function prov(lens: CreativeLens, ref: string): RoutedIdeaProvenance {
  return { ideaId: `idea-${ref}`, lens, rail: 'gym', routedRef: ref };
}

/** Hand-rolled LensOutcomeReport — same invariants as computeLensOutcomes (all lenses present). */
function outcomes(
  perLens: Partial<Record<CreativeLens, { won?: number; lost?: number; pending?: number }>> = {},
): LensOutcomeReport {
  const byLens = Object.fromEntries(
    CREATIVE_LENSES.map((l) => {
      const p = perLens[l] ?? {};
      const won = p.won ?? 0;
      const lost = p.lost ?? 0;
      const pending = p.pending ?? 0;
      const decided = won + lost;
      return [
        l,
        {
          lens: l,
          routed: won + lost + pending,
          won,
          lost,
          pending,
          winRate: decided > 0 ? won / decided : null,
          weight: 1 / CREATIVE_LENSES.length,
        },
      ];
    }),
  ) as LensOutcomeReport['byLens'];
  const total = CREATIVE_LENSES.reduce((a, l) => a + byLens[l].routed, 0);
  return { total, byLens, ranked: CREATIVE_LENSES.map((l) => byLens[l]) };
}

function inputs(p: Partial<ScoutQualityInputs> = {}): ScoutQualityInputs {
  return {
    ticks: p.ticks ?? [],
    routedIdeas: p.routedIdeas ?? [],
    lensOutcomes: p.lensOutcomes ?? outcomes(),
  };
}

/** A report with overridable metric fields (degradation tests don't re-derive). */
function report(over: Partial<ScoutQualityReport> = {}): ScoutQualityReport {
  return { ...computeScoutQualityReport(inputs()), ...over };
}

// ── pure core: the report ─────────────────────────────────────────────────────

describe('computeScoutQualityReport', () => {
  it('empty window: zero counts, all rates null, full zeroed gate breakdown', () => {
    const r = computeScoutQualityReport(inputs());
    expect(r.windowCycles).toBe(0);
    expect(r.totalTicks).toBe(0);
    expect(r.errorTicks).toBe(0);
    expect(r.totalRouted).toBe(0);
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.totalSpendUsd).toBe(0);
    expect(r.triageAcceptanceRate).toBeNull();
    expect(r.ideaToShippedConversion).toBeNull();
    expect(r.costPerAcceptedIdeaUsd).toBeNull();
    // All four gates — incl. 'claim-lost' — always present, zeroed.
    expect(r.gatedTickBreakdown).toEqual(
      Object.fromEntries(SCOUT_TICK_GATES.map((g) => [g, 0])),
    );
    for (const l of CREATIVE_LENSES) expect(r.perLensWinRates[l]).toBeNull();
  });

  it('triageAcceptanceRate = accepted/(accepted+rejected) over decided only — pending excluded', () => {
    const r = computeScoutQualityReport(
      inputs({
        lensOutcomes: outcomes({
          analogical: { won: 3, lost: 1 },
          reframing: { won: 1, lost: 1, pending: 2 },
        }),
      }),
    );
    expect(r.accepted).toBe(4);
    expect(r.rejected).toBe(2);
    expect(r.pending).toBe(2);
    expect(r.triageAcceptanceRate).toBeCloseTo(4 / 6, 9);
  });

  it('ideaToShippedConversion = accepted / ideas generated across ran ticks', () => {
    const r = computeScoutQualityReport(
      inputs({
        ticks: [
          tick({ status: 'ran', ideasGenerated: 10 }),
          tick({ status: 'ran', ideasGenerated: 6 }),
          tick({ status: 'gated', gate: 'no-trigger' }), // generates nothing
        ],
        lensOutcomes: outcomes({ analogical: { won: 4, lost: 2 } }),
      }),
    );
    expect(r.totalIdeasGenerated).toBe(16);
    expect(r.ideaToShippedConversion).toBeCloseTo(4 / 16, 9);
  });

  it('ideaToShippedConversion is null when no ideas were generated (even with wins on the books)', () => {
    const r = computeScoutQualityReport(
      inputs({ lensOutcomes: outcomes({ analogical: { won: 2 } }) }),
    );
    expect(r.ideaToShippedConversion).toBeNull();
  });

  it('perLensWinRates mirrors the lens-outcome winRates (null for undecided lenses)', () => {
    const r = computeScoutQualityReport(
      inputs({
        lensOutcomes: outcomes({
          analogical: { won: 3, lost: 1 },
          reframing: { pending: 5 }, // routed but nothing decided
        }),
      }),
    );
    expect(r.perLensWinRates.analogical).toBeCloseTo(0.75, 9);
    expect(r.perLensWinRates.reframing).toBeNull();
    expect(r.perLensWinRates['first-principles']).toBeNull();
    expect(r.perLensWinRates['constraint-removal']).toBeNull();
  });

  it('costPerAcceptedIdeaUsd = tick spend sum / accepted', () => {
    const r = computeScoutQualityReport(
      inputs({
        ticks: [
          tick({ status: 'ran', ideasGenerated: 8, budgetUsedUsd: 1.25 }),
          tick({ status: 'ran', ideasGenerated: 4, budgetUsedUsd: 0.75 }),
          tick({ status: 'error', budgetUsedUsd: 0.5 }), // failed cycle's spend still counts
        ],
        lensOutcomes: outcomes({ 'first-principles': { won: 2, lost: 1 } }),
      }),
    );
    expect(r.totalSpendUsd).toBeCloseTo(2.5, 9);
    expect(r.costPerAcceptedIdeaUsd).toBeCloseTo(1.25, 9);
  });

  it('costPerAcceptedIdeaUsd is null when nothing accepted (zero-division guard) — spend still summed', () => {
    const r = computeScoutQualityReport(
      inputs({
        ticks: [tick({ status: 'ran', ideasGenerated: 5, budgetUsedUsd: 3 })],
        lensOutcomes: outcomes({ analogical: { lost: 2, pending: 3 } }),
      }),
    );
    expect(r.costPerAcceptedIdeaUsd).toBeNull();
    expect(r.totalSpendUsd).toBe(3);
  });

  it('gatedTickBreakdown tallies per gate — incl. claim-lost — with unknown gates bucketed by name', () => {
    const r = computeScoutQualityReport(
      inputs({
        ticks: [
          tick({ status: 'gated', gate: 'min-interval' }),
          tick({ status: 'gated', gate: 'min-interval' }),
          tick({ status: 'gated', gate: 'no-trigger' }),
          tick({ status: 'gated', gate: 'circuit' }),
          tick({ status: 'gated', gate: 'claim-lost' }),
          tick({ status: 'gated', gate: 'claim-lost' }),
          tick({ status: 'gated', gate: 'some-future-gate' }),
          tick({ status: 'gated' }), // no gate recorded
          tick({ status: 'ran' }),
        ],
      }),
    );
    expect(r.gatedTickBreakdown['min-interval']).toBe(2);
    expect(r.gatedTickBreakdown['no-trigger']).toBe(1);
    expect(r.gatedTickBreakdown.circuit).toBe(1);
    expect(r.gatedTickBreakdown['claim-lost']).toBe(2);
    expect(r.gatedTickBreakdown['some-future-gate']).toBe(1);
    expect(r.gatedTickBreakdown.unknown).toBe(1);
  });

  it('windowCycles counts ran ticks only; errorTicks and totalTicks tally the rest', () => {
    const r = computeScoutQualityReport(
      inputs({
        ticks: [
          tick({ status: 'ran' }),
          tick({ status: 'ran' }),
          tick({ status: 'gated', gate: 'circuit' }),
          tick({ status: 'error' }),
        ],
        routedIdeas: [prov('analogical', 'gym:a'), prov('reframing', 'plan:b')],
      }),
    );
    expect(r.windowCycles).toBe(2);
    expect(r.errorTicks).toBe(1);
    expect(r.totalTicks).toBe(4);
    expect(r.totalRouted).toBe(2);
  });
});

// ── pure core: degradation ────────────────────────────────────────────────────

describe('evaluateQualityDegradation', () => {
  const healthyBaseline = {
    triageAcceptanceRate: 0.8,
    ideaToShippedConversion: 0.3,
    costPerAcceptedIdeaUsd: 2,
  };

  it('missing baseline (null or undefined) → never degraded, even with a terrible report', () => {
    const bad = report({ triageAcceptanceRate: 0, ideaToShippedConversion: 0, costPerAcceptedIdeaUsd: 999 });
    expect(evaluateQualityDegradation(bad, null)).toEqual({ degraded: false, breaches: [] });
    expect(evaluateQualityDegradation(bad, undefined)).toEqual({ degraded: false, breaches: [] });
  });

  it('exactly AT tolerance is NOT degraded (0.8 baseline, 0.1 tolerance, 0.7 current)', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.7 }),
      { triageAcceptanceRate: 0.8 },
      { triageAcceptanceRate: 0.1 },
    );
    expect(v.degraded).toBe(false);
    expect(v.breaches).toEqual([]);
  });

  it('past tolerance IS degraded, with the {metric, baseline, current} breach', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.65 }),
      { triageAcceptanceRate: 0.8 },
      { triageAcceptanceRate: 0.1 },
    );
    expect(v.degraded).toBe(true);
    expect(v.breaches).toEqual([
      { metric: 'triageAcceptanceRate', baseline: 0.8, current: 0.65 },
    ]);
  });

  it('cost uses a RELATIVE band: at +50% not degraded, past it degraded', () => {
    const at = evaluateQualityDegradation(
      report({ costPerAcceptedIdeaUsd: 3 }),
      { costPerAcceptedIdeaUsd: 2 },
      { costPerAcceptedIdeaUsd: 0.5 },
    );
    expect(at.degraded).toBe(false);

    const past = evaluateQualityDegradation(
      report({ costPerAcceptedIdeaUsd: 3.01 }),
      { costPerAcceptedIdeaUsd: 2 },
      { costPerAcceptedIdeaUsd: 0.5 },
    );
    expect(past.degraded).toBe(true);
    expect(past.breaches).toEqual([
      { metric: 'costPerAcceptedIdeaUsd', baseline: 2, current: 3.01 },
    ]);
  });

  it('a per-lens win-rate drop breaches with the perLensWinRates.<lens> metric name', () => {
    const base = report();
    const v = evaluateQualityDegradation(
      report({ perLensWinRates: { ...base.perLensWinRates, analogical: 0.2 } }),
      { perLensWinRates: { analogical: 0.7 } },
      { perLensWinRate: 0.2 },
    );
    expect(v.degraded).toBe(true);
    expect(v.breaches).toEqual([
      { metric: 'perLensWinRates.analogical', baseline: 0.7, current: 0.2 },
    ]);
  });

  it('a null CURRENT metric is skipped (cannot degrade into "unmeasured")', () => {
    const v = evaluateQualityDegradation(report(), healthyBaseline, {});
    // Empty-window report has every rate null → nothing comparable → clean.
    expect(v.degraded).toBe(false);
  });

  it('a null/absent BASELINE metric is skipped', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.1, costPerAcceptedIdeaUsd: 50 }),
      { triageAcceptanceRate: null }, // measured nothing; no cost baseline at all
    );
    expect(v.degraded).toBe(false);
  });

  it('improvement over baseline is never a breach', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.95, ideaToShippedConversion: 0.5, costPerAcceptedIdeaUsd: 1 }),
      healthyBaseline,
    );
    expect(v.degraded).toBe(false);
  });

  it('collects multiple breaches in one verdict', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.4, ideaToShippedConversion: 0.1, costPerAcceptedIdeaUsd: 10 }),
      healthyBaseline,
      DEFAULT_QUALITY_TOLERANCES,
    );
    expect(v.degraded).toBe(true);
    expect(v.breaches.map((b) => b.metric).sort()).toEqual([
      'costPerAcceptedIdeaUsd',
      'ideaToShippedConversion',
      'triageAcceptanceRate',
    ]);
  });

  it('an explicit 0 tolerance breaches on any drop (override is not swallowed by defaults)', () => {
    const v = evaluateQualityDegradation(
      report({ triageAcceptanceRate: 0.75 }),
      { triageAcceptanceRate: 0.8 },
      { triageAcceptanceRate: 0 },
    );
    expect(v.degraded).toBe(true);
  });
});

// ── composition: the injected capture port ────────────────────────────────────

describe('checkAndFlagQuality', () => {
  const degradedInputs = inputs({
    ticks: [tick({ status: 'ran', ideasGenerated: 10, budgetUsedUsd: 5 })],
    lensOutcomes: outcomes({ analogical: { won: 1, lost: 9 } }), // 10% acceptance
  });

  it('not degraded → no capture, captured:false, report+verdict returned', async () => {
    const capture = vi.fn(async () => ({}));
    const res = await checkAndFlagQuality({
      readInputs: async () => degradedInputs,
      baseline: null, // missing baseline → never degraded
      capture,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(res.captured).toBe(false);
    expect(res.verdict.degraded).toBe(false);
    expect(res.report.triageAcceptanceRate).toBeCloseTo(0.1, 9);
  });

  it('degraded → the capture port fires EXACTLY once for the whole breach set', async () => {
    const capture = vi.fn(async (_req: QualityCaptureRequest) => ({}));
    const res = await checkAndFlagQuality({
      readInputs: async () => degradedInputs,
      baseline: { triageAcceptanceRate: 0.8, costPerAcceptedIdeaUsd: 1 }, // both breach
      capture,
    });
    expect(res.captured).toBe(true);
    expect(res.verdict.breaches.length).toBe(2);
    expect(capture).toHaveBeenCalledTimes(1);
    const req = capture.mock.calls[0][0];
    expect(req.kind).toBe('change');
    expect(req.subTopic).toBe('scout-quality');
    expect(req.sourceRole).toBe('system');
    expect(req.body).toContain('triageAcceptanceRate');
    expect(req.body).toContain('costPerAcceptedIdeaUsd');
  });

  it('the capture title is stable for a breach set: sorted, deduped metric names', async () => {
    const titles: string[] = [];
    const deps = {
      readInputs: async () => degradedInputs,
      baseline: { triageAcceptanceRate: 0.8, costPerAcceptedIdeaUsd: 1 },
      capture: async (req: QualityCaptureRequest) => {
        titles.push(req.title);
      },
    };
    await checkAndFlagQuality(deps);
    await checkAndFlagQuality(deps); // same degradation re-checked → identical title
    expect(titles).toHaveLength(2);
    expect(titles[0]).toBe(titles[1]);
    expect(titles[0]).toBe(
      'Scout quality degradation: costPerAcceptedIdeaUsd, triageAcceptanceRate',
    );
  });

  it('qualityBreachTitle sorts and dedups metric names', () => {
    expect(
      qualityBreachTitle({
        degraded: true,
        breaches: [
          { metric: 'triageAcceptanceRate', baseline: 0.8, current: 0.4 },
          { metric: 'costPerAcceptedIdeaUsd', baseline: 1, current: 5 },
          { metric: 'triageAcceptanceRate', baseline: 0.8, current: 0.4 },
        ],
      }),
    ).toBe('Scout quality degradation: costPerAcceptedIdeaUsd, triageAcceptanceRate');
  });

  it('tolerance overrides flow through the composed check', async () => {
    const capture = vi.fn(async () => ({}));
    const res = await checkAndFlagQuality({
      readInputs: async () => degradedInputs,
      baseline: { triageAcceptanceRate: 0.15 },
      tolerances: { triageAcceptanceRate: 0.05 }, // 0.15 → 0.10 is exactly at tolerance
      capture,
    });
    expect(res.captured).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});
