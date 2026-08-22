/**
 * baseline-retains-convergence.test.ts — the retained perf surface must carry
 * the CONVERGENCE verdict, not just the loop-lag SLO.
 *
 * WHY THIS FILE EXISTS. Run artifacts live under `test-results/p2p-perf/`,
 * which is gitignored (`.gitignore:42`). A baseline under `baselines/` is
 * therefore the only p2p-perf evidence that outlives a sweep of local disk.
 * Before the field this file guards, that surviving entry kept `loopLagP95Ms`
 * — which artifact.ts explicitly warns "must never be quoted alone as a scale
 * or correctness verdict" — and dropped `convergence`, the second verdict
 * added (EI-20576392705164447) to stop exactly that misreading.
 *
 * It cost a real claim. On 2026-08-16 the whole 64→128 ladder behind row 14 of
 * `shared-pot-release-testing/RELEASE-READINESS.md` was swept off disk; because
 * no convergence verdict had ever been promoted into a baseline, the signed
 * document's central mesh claim survived only as its own prose, with nothing
 * left to re-derive it from.
 *
 * FALSIFIABILITY. `preFixBaselineEntry` below is a PERMANENT control — a
 * deliberately-wrong builder reproducing the pre-fix shape. The retention
 * assertions are run against BOTH it and the real `baselineFromArtifacts`; the
 * control must fail where the real one passes. Without it, these tests would
 * still pass if someone quietly made the field optional and stopped populating
 * it (tier 1 of the mutation-probe table in CLAUDE.md — a wrong implementation
 * kept in the test file, never a mutation of the shared tree).
 */

import { describe, expect, it } from 'vitest';
import type { ConvergenceStats, MetricSummary, PerfArtifact } from './artifact';
import { baselineFromArtifacts, baselineFromHistory } from './compare';

function metric(p95: number, unit: MetricSummary['unit'] = 'ms'): MetricSummary {
  return { unit, count: 10, p50: p95 * 0.8, p95, p99: p95 * 1.1, max: p95 * 1.2, mean: p95 * 0.85 };
}

/** A convergence verdict shaped like the 64-peer run row 14 signs. */
function convergence(convergedReaders: number, expectedReaders = 63): ConvergenceStats {
  return {
    expectedReaders,
    convergedReaders,
    laggingReaders: Array.from({ length: expectedReaders - convergedReaders }, (_, i) => String(i)),
    p95LimitMs: 60_000,
    observedP95Ms: 14_604,
    budgetMs: 120_000,
    convergedMs: metric(14_604),
  };
}

function artifact(conv: ConvergenceStats | null, latMs = 100): PerfArtifact {
  return {
    schema: 2,
    provenance: null,
    scenario: 'replication.sustained',
    tier: 1,
    params: { peers: 64, rate: 10 },
    startedAt: '2026-08-16T06:20:39.454Z',
    durationMs: 1000,
    host: { hostname: 'h', platform: 'linux', arch: 'x64', cpus: 128, node: 'v22' },
    metrics: { latMs: metric(latMs) },
    loopLag: { p50Ms: 5, p95Ms: 21, p99Ms: 30, maxMs: 40 },
    sloPassed: true,
    sloLimitMs: 100,
    convergence: conv,
    convergencePassed: conv ? conv.convergedReaders === conv.expectedReaders : null,
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    notes: [],
  };
}

/**
 * PERMANENT CONTROL — the pre-fix builder. Keeps the loop-lag SLO, drops the
 * convergence verdict. Never call this in production code; it exists only so
 * the assertions below are provably able to fail.
 */
function preFixBaselineEntry(a: PerfArtifact): Record<string, unknown> {
  return {
    scenario: a.scenario,
    params: a.params,
    metrics: a.metrics,
    loopLagP95Ms: a.loopLag?.p95Ms ?? null,
  };
}

describe('a committed baseline retains the convergence verdict', () => {
  it('carries convergence through a frozen capture', () => {
    const conv = convergence(63);
    const base = baselineFromArtifacts([artifact(conv)], 'ci');

    expect(base.entries).toHaveLength(1);
    expect(base.entries[0].convergence).toEqual(conv);
    // The verdict is only useful if its GOALPOST survives with it: a
    // converged-count with no budget cannot say whether the run passed with
    // 100s of headroom or 200ms of it (EI-20581532536662596).
    expect(base.entries[0].convergence?.budgetMs).toBe(120_000);
    expect(base.entries[0].convergence?.convergedMs?.p95).toBe(14_604);
  });

  it('records a FAILED convergence, not just a passing one', () => {
    // 22/95 — the 96@100 rung. A retention field that only survives on green
    // runs would hide precisely the results worth keeping.
    const base = baselineFromArtifacts([artifact(convergence(22, 95))], 'ci');
    expect(base.entries[0].convergence?.convergedReaders).toBe(22);
    expect(base.entries[0].convergence?.laggingReaders).toHaveLength(73);
  });

  it('CALIBRATION: a scenario that formed no mesh retains null, not a fabricated verdict', () => {
    // Guards the opposite failure — a field that is never null would make
    // "no convergence measured" indistinguishable from "convergence measured".
    const base = baselineFromArtifacts([artifact(null)], 'ci');
    expect(base.entries[0].convergence).toBeNull();
    expect(base.entries[0].loopLagP95Ms).toBe(21);
  });

  it('carries the LATEST convergence through a rolling reference', () => {
    // baselineFromHistory needs >= minRuns (8) runs to return a reference.
    const history = Array.from({ length: 8 }, (_, i) =>
      [artifact(convergence(60 + (i % 4), 63), 100 + i)],
    );
    const base = baselineFromHistory(history, { profile: 'rolling' });

    expect(base).not.toBeNull();
    // Chronological last write wins: run index 7 -> 60 + (7 % 4) = 63.
    expect(base?.entries[0].convergence?.convergedReaders).toBe(63);
  });

  it('CONTROL: the pre-fix builder fails every retention assertion above', () => {
    const conv = convergence(63);
    const preFix = preFixBaselineEntry(artifact(conv));

    // It still carries the number that must NOT be quoted alone...
    expect(preFix.loopLagP95Ms).toBe(21);
    // ...and has silently dropped the one that must be. If this ever stops
    // being undefined, the control has drifted into agreeing with the real
    // implementation and no longer proves the assertions can fail.
    expect(preFix.convergence).toBeUndefined();

    // The real builder, same artifact, keeps it — this pairing IS the proof.
    const real = baselineFromArtifacts([artifact(conv)], 'ci');
    expect(real.entries[0].convergence).not.toBeUndefined();
    expect(real.entries[0].convergence).toEqual(conv);
  });
});
