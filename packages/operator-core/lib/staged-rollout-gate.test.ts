import { describe, expect, it } from 'vitest';

import {
  type CodeRunInstrumentationRollup,
  type StagedRolloutThresholds,
  evaluateStagedRollout,
} from './code-run-adoption';

/**
 * WI-40720 gap 4 — the staged rollout acceptance evaluator.
 *
 * The property under test is NOT "does it compute the ratios". It is that the gate REFUSES to
 * say `qualified` on evidence that merely LOOKS clean. Every test below is therefore built the
 * same way: start from a window that would qualify, break exactly ONE thing, and assert the
 * verdict flips. A suite that only tested the happy path would pass just as well against a
 * function that returned `qualified` unconditionally.
 */

/** A window with no breaches, real denominators, and healthy ratios. */
function healthyRollup(over: Partial<CodeRunInstrumentationRollup> = {}): CodeRunInstrumentationRollup {
  return {
    runs: 500,
    backendCounts: { server: 500 },
    toolCalls: 1200,
    intermediateBytes: 5_000_000,
    returnedContextBytes: 500_000,
    spilledBytes: 20_000,
    durationMs: 250_000,
    failedRuns: 5,
    failureClassCounts: { adapter_failed: 5 },
    recipeCaptures: 30,
    recipeReuses: 80,
    recipeCacheHits: 40,
    recipeCandidates: 25,
    recipeRevisions: 12,
    aggregateOutputEscapes: 0,
    spills: 40,
    spillReadAttempts: 38,
    spillReadSuccesses: 36,
    backendMismatches: 0,
    preflightFailures: 3,
    capabilityMisses: 0,
    recipeRequests: 100,
    spillFailures: 0,
    ...over,
  };
}

const THRESHOLDS: StagedRolloutThresholds = {
  minRuns: 100,
  minWindowMs: 3_600_000,
  maxFailureRate: 0.05,
  minSpillResolutionRate: 0.8,
  minRecipeReuseRate: 0.5,
  maxMeanReturnedContextBytes: 5_000,
  maxMeanDurationMs: 1_000, // healthy fixture: 250_000ms / 500 runs = 500ms
  minBackendRoutingAccuracy: 0.99, // healthy fixture: (500 - 0) / 500 = 1.0
};

const WINDOW_START = 1_000_000_000_000;
const WINDOW_END = WINDOW_START + 7_200_000; // 2h

function evaluate(over: {
  rollup?: Partial<CodeRunInstrumentationRollup>;
  thresholds?: Partial<StagedRolloutThresholds>;
  build?: Partial<{ status: 'measured' | 'not_measured'; sidecarSha: string | null; sidecarStartedAtMs: number | null }>;
  windowStartMs?: number;
  windowEndMs?: number;
} = {}) {
  return evaluateStagedRollout({
    rollup: healthyRollup(over.rollup),
    thresholds: { ...THRESHOLDS, ...over.thresholds },
    buildIdentity: {
      status: 'measured',
      sidecarSha: 'abc123',
      // Default: the build predates the window, so the window is attributable.
      sidecarStartedAtMs: WINDOW_START - 60_000,
      ...over.build,
    },
    windowStartMs: over.windowStartMs ?? WINDOW_START,
    windowEndMs: over.windowEndMs ?? WINDOW_END,
  });
}

describe('evaluateStagedRollout — the qualifying baseline', () => {
  it('QUALIFIES a window that is attributable, long enough, populated and within every threshold', () => {
    const out = evaluate();
    // Asserted explicitly so that every "flips to not_qualified" test below is meaningful:
    // without a reachable `qualified`, they would all pass vacuously.
    expect(out.acceptance).toBe('qualified');
    expect(out.blockers).toEqual([]);
    expect(out.hardTriggers).toEqual([]);
  });
});

describe('evaluateStagedRollout — hard triggers are invariant breaches, not thresholds', () => {
  const cases = [
    ['aggregateOutputEscapes', 'aggregate_output_escape'],
    ['spillFailures', 'spill_persistence_failure'],
    ['backendMismatches', 'server_backend_mismatch'],
    ['capabilityMisses', 'capability_unavailable'],
  ] as const;

  for (const [field, id] of cases) {
    it(`fires ${id} on a SINGLE occurrence, and that alone disqualifies the window`, () => {
      const out = evaluate({ rollup: { [field]: 1 } as Partial<CodeRunInstrumentationRollup> });
      expect(out.hardTriggers.map((t) => t.id)).toContain(id);
      expect(out.acceptance).toBe('not_qualified');
    });
  }

  it('fires no trigger when every breach count is zero', () => {
    expect(evaluate().hardTriggers).toEqual([]);
  });
});

describe('evaluateStagedRollout — absence of evidence is never a pass', () => {
  it('treats ZERO SPILLS as not_measured, NOT as a perfect spill-resolution rate', () => {
    // The single most dangerous reading in this gate: 0/0 spill resolution is trivially "no
    // failures", and rendering it as 100% would certify spill handling that was never exercised.
    const out = evaluate({ rollup: { spills: 0, spillReadAttempts: 0, spillReadSuccesses: 0 } });
    expect(out.ratios.spillResolutionRate.status).toBe('not_measured');
    expect(out.ratios.spillResolutionRate.value).toBeNull();
    expect(out.acceptance).toBe('not_qualified');
    expect(out.blockers.join(' ')).toContain('spillResolutionRate is not measured');
  });

  it('treats ZERO RECIPE REQUESTS as not_measured, not as zero reuse', () => {
    const out = evaluate({ rollup: { recipeRequests: 0, recipeReuses: 0 } });
    expect(out.ratios.recipeReuseRate.status).toBe('not_measured');
    expect(out.acceptance).toBe('not_qualified');
  });

  it('treats an EMPTY window as unmeasured on every run-denominated ratio', () => {
    const out = evaluate({ rollup: { runs: 0, failedRuns: 0, returnedContextBytes: 0 } });
    expect(out.ratios.failureRate.status).toBe('not_measured');
    expect(out.ratios.meanReturnedContextBytes.status).toBe('not_measured');
    expect(out.acceptance).toBe('not_qualified');
  });

  it('refuses to qualify when a threshold is NULL — measured but unjudged is not a pass', () => {
    const out = evaluate({ thresholds: { maxFailureRate: null } });
    expect(out.ratios.failureRate.status).toBe('measured');
    expect(out.ratios.failureRate.verdict).toBe('unjudged');
    expect(out.acceptance).toBe('not_qualified');
    expect(out.blockers.join(' ')).toContain('failureRate has no threshold');
  });

  it('refuses to qualify with no minimum window or minimum sample supplied', () => {
    const out = evaluate({ thresholds: { minWindowMs: null, minRuns: null } });
    expect(out.acceptance).toBe('not_qualified');
    expect(out.blockers.join(' ')).toContain('no minimum window length supplied');
    expect(out.blockers.join(' ')).toContain('no minimum run count supplied');
  });
});

describe('evaluateStagedRollout — the window must provably belong to the measured build', () => {
  it('REFUSES a window the build started INSIDE, even when every metric is healthy', () => {
    // The leader's ruling: rows spanning a sidecar restart mix pre- and post-build calls, so
    // stamping the new sha over them attributes old behaviour to new code. This is the case that
    // looks most like a pass and is most wrong — every ratio below is identical to the
    // qualifying baseline; only the build start moved.
    const out = evaluate({ build: { sidecarStartedAtMs: WINDOW_START + 60_000 } });
    expect(out.window.attributedToBuild).toBe(false);
    expect(out.window.attributionReason).toContain('INSIDE the window');
    expect(out.acceptance).toBe('not_qualified');
    // Proof this is the ONLY thing wrong — no ratio or trigger contributed.
    expect(out.hardTriggers).toEqual([]);
    expect(out.blockers).toHaveLength(1);
  });

  it('REFUSES a measured build whose start time is unknown', () => {
    const out = evaluate({ build: { sidecarStartedAtMs: null } });
    expect(out.window.attributedToBuild).toBe(false);
    expect(out.window.attributionReason).toContain('start time is unknown');
    expect(out.acceptance).toBe('not_qualified');
  });

  it('REFUSES an unmeasured build identity outright', () => {
    const out = evaluate({ build: { status: 'not_measured', sidecarSha: null, sidecarStartedAtMs: null } });
    expect(out.window.attributedToBuild).toBe(false);
    expect(out.acceptance).toBe('not_qualified');
  });

  it('ACCEPTS a build that started exactly AT the window start (boundary is inclusive)', () => {
    const out = evaluate({ build: { sidecarStartedAtMs: WINDOW_START } });
    expect(out.window.attributedToBuild).toBe(true);
    expect(out.acceptance).toBe('qualified');
  });
});

describe('evaluateStagedRollout — soft thresholds', () => {
  it('fails a window whose failure rate exceeds the stated maximum', () => {
    const out = evaluate({ rollup: { failedRuns: 100 } }); // 100/500 = 20% vs 5%
    expect(out.ratios.failureRate.verdict).toBe('fail');
    expect(out.acceptance).toBe('not_qualified');
  });

  it('fails a window whose spill resolution falls below the stated minimum', () => {
    const out = evaluate({ rollup: { spills: 40, spillReadSuccesses: 4 } }); // 10% vs 80%
    expect(out.ratios.spillResolutionRate.verdict).toBe('fail');
    expect(out.acceptance).toBe('not_qualified');
  });

  it('fails a window that is shorter than the required minimum', () => {
    const out = evaluate({ windowEndMs: WINDOW_START + 60_000 });
    expect(out.acceptance).toBe('not_qualified');
    expect(out.blockers.join(' ')).toContain('shorter than the required');
  });

  it('fails a window with too few runs even when the rates look good', () => {
    const out = evaluate({ rollup: { runs: 10, failedRuns: 0, returnedContextBytes: 1_000 } });
    expect(out.acceptance).toBe('not_qualified');
    expect(out.blockers.join(' ')).toContain('fewer than the required');
  });
});

describe('evaluateStagedRollout — action separates ROLLBACK from HOLD', () => {
  // The distinction this suite exists to protect: `not_qualified` covers both "we violated an
  // invariant" and "we do not yet know". Treating those alike either discards healthy rollouts
  // on thin evidence, or buries a real breach among routine holds.

  it('FULL PASS ⇒ advance', () => {
    const out = evaluate();
    expect(out.action).toBe('advance');
    expect(out.acceptance).toBe('qualified');
  });

  it('HARD TRIGGER ONLY ⇒ rollback, even with every soft metric healthy and the window attributed', () => {
    const out = evaluate({ rollup: { aggregateOutputEscapes: 1 } });
    expect(out.action).toBe('rollback');
    expect(out.hardTriggers).toHaveLength(1);
  });

  it('SOFT FAILURE ⇒ hold, NOT rollback — a regression is not an invariant breach', () => {
    const out = evaluate({ rollup: { failedRuns: 100 } });
    expect(out.action).toBe('hold');
    expect(out.hardTriggers).toEqual([]);
    expect(out.acceptance).toBe('not_qualified');
  });

  it('ZERO EVIDENCE ⇒ hold, NOT advance and NOT rollback', () => {
    // The case a naive gate gets exactly backwards in both directions: nothing bad was observed
    // because nothing at all was observed.
    const out = evaluate({
      rollup: { runs: 0, failedRuns: 0, spills: 0, spillReadSuccesses: 0, recipeRequests: 0, recipeReuses: 0, durationMs: 0, returnedContextBytes: 0 },
    });
    expect(out.action).toBe('hold');
    expect(out.hardTriggers).toEqual([]);
  });

  it('a hard trigger OUTRANKS missing evidence — rollback wins over hold', () => {
    const out = evaluate({ rollup: { runs: 0, failedRuns: 0, spills: 0, capabilityMisses: 2 } });
    expect(out.action).toBe('rollback');
  });
});

describe('evaluateStagedRollout — latency and backend routing accuracy (P-020 named gates)', () => {
  it('measures mean duration and fails a window that exceeds the stated ceiling', () => {
    expect(evaluate().ratios.meanDurationMs).toMatchObject({ status: 'measured', value: 500, verdict: 'pass' });
    const slow = evaluate({ rollup: { durationMs: 5_000_000 } }); // 10_000ms mean
    expect(slow.ratios.meanDurationMs.verdict).toBe('fail');
    expect(slow.action).toBe('hold');
  });

  it('measures routing accuracy as (runs - mismatches) / runs', () => {
    expect(evaluate().ratios.backendRoutingAccuracy).toMatchObject({ status: 'measured', value: 1, verdict: 'pass' });
    // A mismatch is BOTH a hard trigger and an accuracy hit; the accuracy can still look high.
    const drifted = evaluate({ rollup: { backendMismatches: 5 } }); // 495/500 = 0.99
    expect(drifted.ratios.backendRoutingAccuracy.status).toBe('measured');
    expect(drifted.action).toBe('rollback');
  });

  it('reports both new ratios as not_measured on an empty window', () => {
    const out = evaluate({ rollup: { runs: 0, durationMs: 0 } });
    expect(out.ratios.meanDurationMs.status).toBe('not_measured');
    expect(out.ratios.backendRoutingAccuracy.status).toBe('not_measured');
  });
});

describe('evaluateStagedRollout — malformed inputs are refused, not normalised', () => {
  it('refuses a build claiming status=measured with a null sha', () => {
    const out = evaluate({ build: { sidecarSha: null } });
    expect(out.window.attributedToBuild).toBe(false);
    expect(out.window.attributionReason).toContain('no sha');
    expect(out.action).toBe('hold');
  });

  it('refuses a build claiming status=measured with a blank sha', () => {
    const out = evaluate({ build: { sidecarSha: '   ' } });
    expect(out.window.attributedToBuild).toBe(false);
    expect(out.window.attributionReason).toContain('no sha');
  });

  it('names an INVERTED window instead of letting it read as merely too short', () => {
    const out = evaluate({ windowStartMs: WINDOW_END, windowEndMs: WINDOW_START });
    expect(out.blockers.join(' ')).toContain('window is inverted');
    expect(out.acceptance).toBe('not_qualified');
  });
});

describe('evaluateStagedRollout — purity', () => {
  it('is deterministic: identical inputs give identical verdicts', () => {
    expect(evaluate()).toEqual(evaluate());
  });

  it('does not mutate the rollup it was given', () => {
    const rollup = healthyRollup();
    const snapshot = JSON.parse(JSON.stringify(rollup));
    evaluateStagedRollout({
      rollup,
      thresholds: THRESHOLDS,
      buildIdentity: { status: 'measured', sidecarSha: 'abc123', sidecarStartedAtMs: WINDOW_START - 1 },
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(rollup).toEqual(snapshot);
  });
});
