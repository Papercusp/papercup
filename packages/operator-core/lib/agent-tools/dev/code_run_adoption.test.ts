import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sqlUnsafe: vi.fn(async () => [{ nudged_sessions: '8', converted_sessions: '5' }]),
  readCodeRunAdoption: vi.fn(async () => []),
  rollupAdoption: vi.fn(() => ({
    opportunitySpawns: 4,
    opportunitySpawnsUsingCodeRun: 3,
    adoptionRate: 0.75,
  })),
  gradeToolUtilization: vi.fn(() => ({ rating: 'healthy', evidence: 'adoption 75%' })),
  readCodeRunInstrumentation: vi.fn(async () => ({
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
