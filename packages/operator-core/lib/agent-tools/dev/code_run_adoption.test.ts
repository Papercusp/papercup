import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeRunInstrumentationRollup } from '../../code-run-adoption';
import type { StagingBuildIdentity } from '../../harness/dev-operators';

const M = vi.hoisted(() => ({
  sqlUnsafe: vi.fn(async () => [{ nudged_sessions: '8', converted_sessions: '5' }]),
  readCodeRunAdoption: vi.fn(async () => []),
  rollupAdoption: vi.fn(() => ({
    opportunitySpawns: 4,
    opportunitySpawnsUsingCodeRun: 3,
    adoptionRate: 0.75,
  })),
  gradeToolUtilization: vi.fn(() => ({ rating: 'healthy', evidence: 'adoption 75%' })),
  readCodeRunInstrumentation: vi.fn(async (): Promise<CodeRunInstrumentationRollup> => ({
    runs: 2,
    backendCounts: { server: 2 },
    toolCalls: 9,
    intermediateBytes: 32_485,
    returnedContextBytes: 2_000,
    spilledBytes: 31_000,
    durationMs: 9_488,
    failedRuns: 1,
    failureClassCounts: { timeout: 1 },
    recipeCaptures: 1,
    recipeReuses: 0,
    recipeCacheHits: 0,
    recipeCandidates: 3,
    recipeRevisions: 1,
    aggregateOutputEscapes: 1,
    // Kept schema-complete with CodeRunInstrumentationRollup. A fixture that silently falls a
    // field behind the real rollup makes every downstream reader see `undefined`, which compares
    // as "not greater than zero" — i.e. a missing hard-trigger count would read as NO BREACH.
    spills: 0,
    spillReadAttempts: 0,
    spillReadSuccesses: 0,
    backendMismatches: 0,
    preflightFailures: 0,
    capabilityMisses: 0,
    recipeRequests: 0,
    spillFailures: 0,
  })),
  readStagingBuildIdentity: vi.fn(async (): Promise<StagingBuildIdentity> => ({
    status: 'not_measured',
    reason: 'unreachable',
    sidecarSha: null,
    sidecarStartedAtMs: null,
    origin: 'http://127.0.0.1:3170',
  })),
  readNativeExecRouting: vi.fn(async () => ({
    nativeExecCalls: 3,
    nativeExecSessions: 2,
    routedRunCalls: 7,
    routedRunSessions: 5,
    routedFraction: 0.7,
  })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: { unsafe: M.sqlUnsafe } }) };
});

vi.mock('../../code-run-adoption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../code-run-adoption')>();
  return {
    ...actual,
    readCodeRunAdoption: M.readCodeRunAdoption,
    rollupAdoption: M.rollupAdoption,
    gradeToolUtilization: M.gradeToolUtilization,
    readCodeRunInstrumentation: M.readCodeRunInstrumentation,
    readNativeExecRouting: M.readNativeExecRouting,
  };
});

vi.mock('../../harness/dev-operators', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/dev-operators')>();
  return { ...actual, readStagingBuildIdentity: M.readStagingBuildIdentity };
});

import tool from './code_run_adoption';

type ToolResult = { content: Array<{ type: string; text: string }> };

function body(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

async function run(sinceDays = 7): Promise<Record<string, any>> {
  return body((await tool.handler({ sinceDays } as never, {} as never)) as ToolResult);
}

beforeEach(() => {
  vi.clearAllMocks();
  M.sqlUnsafe.mockResolvedValue([{ nudged_sessions: '8', converted_sessions: '5' }]);
});

describe('dev:code_run_adoption P-008 dashboard wiring', () => {
  it('surfaces exact run metrics, D-017 routing, and the frozen P-002 comparison', async () => {
    const out = await run(14);

    expect(M.readCodeRunInstrumentation).toHaveBeenCalledWith(expect.any(Function), 14);
    expect(M.readNativeExecRouting).toHaveBeenCalledWith(expect.any(Function), 14);
    expect(out.runQuality).toMatchObject({
      totals: {
        backendCounts: { server: 2 },
        intermediateBytes: 32_485,
        returnedContextBytes: 2_000,
        spilledBytes: 31_000,
        aggregateOutputEscapes: 1,
      },
      perRun: {
        toolCalls: 4.5,
        intermediateBytes: 16_242.5,
        returnedContextBytes: 1_000,
        spilledBytes: 15_500,
        durationMs: 4_744,
      },
      p002Baseline: {
        incidentId: 'incident-01a02a75-nine-read-fanout',
        incidentMetrics: {
          intermediateBytes: 32_485,
          returnedContextBytes: 35_336,
          toolCalls: 9,
          latencyMs: 9_488,
        },
        authoredSummaryBudgetChars: 1_250,
        clientOnlyResidue: {
          totalCalls: 235_074,
          lowerCalls: 147_103,
          upperCalls: 153_635,
          lowerFraction: expect.closeTo(0.6258, 4),
          upperFraction: expect.closeTo(0.6536, 4),
        },
      },
    });
    expect(out.nativeExecRouting).toMatchObject({ routedFraction: 0.7 });
    expect(out.alerts.aggregateOutputEscape).toMatchObject({
      status: 'firing',
      severity: 'critical',
      threshold: 0,
      count: 1,
    });
    expect(out.nudge).toEqual({ nudgedSessions: 8, convertedSessions: 5 });
  });

  it('returns null averages and a clear alert when the window contains no runs', async () => {
    M.readCodeRunInstrumentation.mockResolvedValueOnce({
      runs: 0,
      backendCounts: {},
      toolCalls: 0,
      intermediateBytes: 0,
      returnedContextBytes: 0,
      spilledBytes: 0,
      durationMs: 0,
      failedRuns: 0,
      failureClassCounts: {},
      recipeCaptures: 0,
      recipeReuses: 0,
      recipeCacheHits: 0,
      recipeCandidates: 0,
      recipeRevisions: 0,
      aggregateOutputEscapes: 0,
    } as never);

    const out = await run();
    expect(out.runQuality.perRun).toEqual({
      toolCalls: null,
      intermediateBytes: null,
      returnedContextBytes: null,
      spilledBytes: null,
      durationMs: null,
    });
    expect(out.alerts.aggregateOutputEscape).toMatchObject({ status: 'clear', count: 0 });
  });
});

describe('dev:code_run_adoption — WI-40720 gap 4 staged-rollout verdict is EMITTED, not just computable', () => {
  /** A window with no invariant breach and healthy denominators.
   *
   *  Typed as the REAL rollup with a Partial override seam, deliberately not cast: the moment
   *  CodeRunInstrumentationRollup gains a required field, THIS fixture fails to compile and gets
   *  fixed here — instead of silently passing `undefined` into the evaluator, where a missing
   *  hard-trigger count compares as "not greater than zero" and a breach reads as clean. */
  const cleanRollup = (over: Partial<CodeRunInstrumentationRollup> = {}): CodeRunInstrumentationRollup => ({
    runs: 500,
    backendCounts: { server: 500 },
    toolCalls: 1200,
    intermediateBytes: 5_000_000,
    returnedContextBytes: 500_000, // mean 1_000
    spilledBytes: 20_000,
    durationMs: 250_000, // mean 500
    failedRuns: 5, // 1%
    failureClassCounts: { timeout: 5 },
    recipeCaptures: 30,
    recipeReuses: 80, // 80%
    recipeCacheHits: 40,
    recipeCandidates: 25,
    recipeRevisions: 12,
    aggregateOutputEscapes: 0,
    spills: 40,
    spillReadAttempts: 38,
    spillReadSuccesses: 36, // 90%
    backendMismatches: 0,
    preflightFailures: 3,
    capabilityMisses: 0,
    recipeRequests: 100,
    spillFailures: 0,
    ...over,
  });

  const FULL_THRESHOLDS = {
    minRuns: 100,
    minWindowMs: 3_600_000,
    maxFailureRate: 0.05,
    minSpillResolutionRate: 0.8,
    minRecipeReuseRate: 0.5,
    maxMeanReturnedContextBytes: 5_000,
    maxMeanDurationMs: 1_000,
    minBackendRoutingAccuracy: 0.99,
  };

  async function runWith(args: Record<string, unknown>): Promise<Record<string, any>> {
    return body((await tool.handler(args as never, {} as never)) as ToolResult);
  }

  function attributedBuild() {
    // Started well before any window this suite queries, so attribution is satisfied.
    M.readStagingBuildIdentity.mockResolvedValue({
      status: 'measured',
      sidecarSha: 'deadbeef',
      sidecarStartedAtMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
      origin: 'http://127.0.0.1:3170',
    });
  }

  it('emits a stagedRollout verdict at all — the D-052 rail against an uncalled helper', async () => {
    const out = await run(7);
    // The whole point of the wiring: the verdict must reach a caller through this door.
    expect(out.stagedRollout).toBeDefined();
    expect(out.stagedRollout.action).toBeDefined();
    expect(out.window).toMatchObject({ startMs: expect.any(Number), endMs: expect.any(Number) });
  });

  it('DEFAULT (no thresholds supplied) ⇒ hold, never advance', async () => {
    M.readCodeRunInstrumentation.mockResolvedValue(cleanRollup());
    attributedBuild();
    const out = await runWith({ sinceDays: 7 });
    // Everything measurable is healthy and the build is attributed; the ONLY thing missing is a
    // stated policy. That must not read as success.
    expect(out.stagedRollout.action).toBe('hold');
    expect(out.stagedRollout.acceptance).toBe('not_qualified');
    expect(out.stagedRollout.blockers.join(' ')).toContain('no threshold');
  });

  it('EXPLICIT full pass ⇒ advance', async () => {
    M.readCodeRunInstrumentation.mockResolvedValue(cleanRollup());
    attributedBuild();
    const out = await runWith({ sinceDays: 7, rolloutThresholds: FULL_THRESHOLDS });
    expect(out.stagedRollout.acceptance).toBe('qualified');
    expect(out.stagedRollout.action).toBe('advance');
    expect(out.stagedRollout.blockers).toEqual([]);
  });

  it('a hard trigger ⇒ rollback EVEN WITH a full threshold set and an attributed build', async () => {
    M.readCodeRunInstrumentation.mockResolvedValue(cleanRollup({ spillFailures: 1 }));
    attributedBuild();
    const out = await runWith({ sinceDays: 7, rolloutThresholds: FULL_THRESHOLDS });
    expect(out.stagedRollout.action).toBe('rollback');
    expect(out.stagedRollout.hardTriggers.map((t: { id: string }) => t.id)).toContain('spill_persistence_failure');
  });

  it('an UNATTRIBUTED build holds even with a full threshold set and a clean window', async () => {
    M.readCodeRunInstrumentation.mockResolvedValue(cleanRollup());
    // Default mock identity is not_measured (the sidecar was unreachable).
    const out = await runWith({ sinceDays: 7, rolloutThresholds: FULL_THRESHOLDS });
    expect(out.stagedRollout.action).toBe('hold');
    expect(out.stagedRollout.window.attributedToBuild).toBe(false);
  });

  it('the emitted window is STABLE — the verdict describes the same interval it reports', async () => {
    M.readCodeRunInstrumentation.mockResolvedValue(cleanRollup());
    attributedBuild();
    const out = await runWith({ sinceDays: 7 });
    expect(out.stagedRollout.window.startMs).toBe(out.window.startMs);
    expect(out.stagedRollout.window.endMs).toBe(out.window.endMs);
    expect(out.window.endMs - out.window.startMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
