/**
 * scorecard-emission-pulse — the scheduled rubric-emission floor (WI-2374 step 1).
 *
 * The contract under test: the pulse files the deterministic floor ONLY when the
 * flag is on, a hive resolves, and NO scorecard (agent OR synthesized) landed
 * in-window — and it deliberately IGNORES the overwatch started bit (decoupling
 * emission from supervisor aliveness was the point). Fully deps-injected (the
 * backstop's seam pattern): no PG / flags / vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runScorecardEmissionPulse,
  PULSE_WINDOW_MS,
  type ScorecardEmissionPulseDeps,
} from './scorecard-emission-pulse';
import {
  COORDINATION_CRITERIA,
  COORDINATION_RUBRIC_REF,
} from './overwatch/scorecard-backstop';
import type { SystemHealth } from './system-health/types';
import type { ScorecardFreshness } from './scorecard-freshness';

const EMPTY_HEALTH = { panels: {}, evaluatedAt: 0 } as unknown as SystemHealth;

function freshnessResult(over: Partial<ScorecardFreshness> = {}): ScorecardFreshness {
  return {
    rubricRef: COORDINATION_RUBRIC_REF,
    since: '2026-07-04T00:00:00Z',
    status: 'stale',
    emitted: false,
    complete: false,
    count: 0,
    partialCount: 0,
    lastEmittedAt: null,
    lastCompleteAt: null,
    latestMissingKeys: [],
    ...over,
  };
}

function mkDeps(over: Partial<ScorecardEmissionPulseDeps> = {}): {
  deps: ScorecardEmissionPulseDeps;
  capture: ReturnType<typeof vi.fn>;
  recordFire: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn(async () => ({}) as never);
  const recordFire = vi.fn(async () => {});
  return {
    capture,
    recordFire,
    deps: {
      enabled: async () => true,
      controlState: async () => ({ hiveSlug: 'papercusp' }),
      freshness: vi.fn(async () => freshnessResult()),
      computeHealth: async () => EMPTY_HEALTH,
      capture: capture as never,
      recordFire,
      toolUtilizationGrade: async () => undefined,
      ...over,
    },
  };
}

describe('runScorecardEmissionPulse', () => {
  it('empty window → files the floor (all 14 criteria, synthesized, synthSource scheduled-pulse) + records the fire', async () => {
    const { deps, capture, recordFire } = mkDeps();
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('filed');
    expect(capture).toHaveBeenCalledTimes(1);
    const arg = capture.mock.calls[0][0] as Record<string, any>;
    const obs = arg.payloadExtra.observation;
    expect(obs.rubricRef).toBe(COORDINATION_RUBRIC_REF);
    expect(obs.synthesized).toBe(true);
    expect(obs.synthSource).toBe('scheduled-pulse');
    // every rubric criterion present with non-empty evidence (the capture gates require it)
    for (const k of COORDINATION_CRITERIA) {
      expect(obs.ratings[k]?.rating, k).toBeTruthy();
      expect(obs.ratings[k]?.evidence?.length, k).toBeGreaterThan(0);
    }
    expect(recordFire).toHaveBeenCalledTimes(1);
  });

  it('the DECOUPLING assertion: files even though overwatch is stopped — started is never consulted', async () => {
    // controlState deliberately returns NO started bit; the pulse must not need one.
    const { deps, capture } = mkDeps({ controlState: async () => ({ hiveSlug: 'papercusp' }) });
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('filed');
    expect(capture).toHaveBeenCalled();
  });

  it('a scorecard already in-window (agent or floor) → skipped, nothing filed', async () => {
    const { deps, capture } = mkDeps({
      freshness: async () =>
        freshnessResult({ status: 'fresh', emitted: true, complete: true, count: 2, lastEmittedAt: '2026-07-04T06:30:00Z' }),
    });
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('already in-window');
    expect(capture).not.toHaveBeenCalled();
  });

  it('the freshness read counts SYNTHESIZED floors (floors never stack) over the pulse window', async () => {
    const freshness = vi.fn(async () => freshnessResult({ emitted: true, count: 1 }));
    const { deps } = mkDeps({ freshness: freshness as never });
    await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({
        rubricRef: COORDINATION_RUBRIC_REF,
        sourceHive: 'papercusp',
        lookbackMs: PULSE_WINDOW_MS,
        includeSynthesized: true,
      }),
    );
  });

  it('flag off → skipped (the one kill switch)', async () => {
    const { deps, capture } = mkDeps({ enabled: async () => false });
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('flag off');
    expect(capture).not.toHaveBeenCalled();
  });

  it('no hive for the workspace → skipped', async () => {
    const { deps, capture } = mkDeps({ controlState: async () => ({ hiveSlug: null }) });
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('no hive');
    expect(capture).not.toHaveBeenCalled();
  });

  it('a throwing capture → outcome error, NEVER a throw into the scheduler', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { deps } = mkDeps({
        capture: (async () => {
          throw new Error('pg down');
        }) as never,
      });
      const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
      expect(r.outcome).toBe('error');
      expect(r.reason).toContain('pg down');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a failing toolUtilizationGrade path still files with honest unknown (grade undefined)', async () => {
    const { deps, capture } = mkDeps({ toolUtilizationGrade: async () => undefined });
    await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    const obs = (capture.mock.calls[0][0] as Record<string, any>).payloadExtra.observation;
    expect(obs.ratings['tool-utilization'].rating).toBe('unknown');
  });
});
