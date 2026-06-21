/**
 * scorecard-backstop.test.ts — the Overwatch scorecard-emission backstop
 * (hive-loop-supervision 2026-06-21). Hermetic: the pure synthesizer is tested
 * directly; the end-check injects ALL externals (flag/started/control-state/
 * freshness/computeHealth/capture/recordFire) so it runs without PG, flags, or vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  synthesizeCoordinationScorecard,
  overwatchScorecardEndCheck,
  COORDINATION_CRITERIA,
  COORDINATION_RUBRIC_REF,
  type OverwatchScorecardEndCheckDeps,
} from './scorecard-backstop';
import type { SystemHealth } from '../system-health/types';

// ── builders ──────────────────────────────────────────────────────────────────

const BASE = {
  workFeed: { frontier: 0, frontierBlocked: 0, startedPlans: 1, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [] },
  bees: { running: 2, alive: 2, stale: 0, orphanedClaims: 0, totalLoad: 2, placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 1 } },
  queen: { workingTracked: 1, stalled: false },
  watchdog: { fires24h: 0, livenessArmed: true, staleForMs: 0, recentErrors: 0 },
  scout: { lastTickAt: 1, lastRanAt: 1, ideasLastRun: 3, ideasInWindow: 6, ranInWindow: 2, transportDeath: false },
  plans: { active: 3, started: 2, shipped: 0, draft: 1, itemsDone: 0, itemsTotal: 0, stalledPlans: 0, startedDraft: 0 },
};

/** Build a SystemHealth with per-panel data; pass `null` to simulate a failed (unread) panel. */
function mkHealth(over: Partial<Record<keyof typeof BASE, unknown>> = {}): SystemHealth {
  const pick = (k: keyof typeof BASE) => (k in over ? over[k] : BASE[k]);
  const panel = (data: unknown) => ({ data });
  return {
    panels: {
      workFeed: panel(pick('workFeed')),
      bees: panel(pick('bees')),
      queen: panel(pick('queen')),
      watchdog: panel(pick('watchdog')),
      scout: panel(pick('scout')),
      plans: panel(pick('plans')),
    },
  } as unknown as SystemHealth;
}

function assertWellFormed(ratings: Record<string, { rating: string; evidence: string }>) {
  // exactly the 13 rubric criteria, each with a non-empty rating + non-empty evidence
  expect(Object.keys(ratings).sort()).toEqual([...COORDINATION_CRITERIA].sort());
  for (const k of COORDINATION_CRITERIA) {
    expect(ratings[k].rating.trim().length).toBeGreaterThan(0);
    expect(ratings[k].evidence.trim().length).toBeGreaterThan(0);
    expect(['healthy', 'degraded', 'broken', 'unknown']).toContain(ratings[k].rating);
  }
}

// ── the pure synthesizer ────────────────────────────────────────────────────────

describe('synthesizeCoordinationScorecard', () => {
  it('returns all 13 keys, each with non-empty evidence', () => {
    assertWellFormed(synthesizeCoordinationScorecard(mkHealth()));
  });

  it('a stuck / no-placement / no-bee brief → end-to-end-flow is NOT healthy', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        workFeed: { ...BASE.workFeed, autoEligibleStuck: 126, frontier: 0 },
        bees: { ...BASE.bees, running: 0, placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 } },
        queen: { workingTracked: 0, stalled: true },
      }),
    );
    assertWellFormed(r);
    expect(r['end-to-end-flow'].rating).toBe('broken'); // >=50 stuck
    expect(r['end-to-end-flow'].rating).not.toBe('healthy');
    expect(r['queen-workitem-selection'].rating).toBe('degraded'); // stuck>0 + workingTracked 0
    expect(r['end-to-end-flow'].evidence).toContain('126');
  });

  it('a clean brief → end-to-end-flow healthy; mid backlog → degraded', () => {
    expect(synthesizeCoordinationScorecard(mkHealth())['end-to-end-flow'].rating).toBe('healthy');
    const mid = synthesizeCoordinationScorecard(mkHealth({ workFeed: { ...BASE.workFeed, autoEligibleStuck: 5 } }));
    expect(mid['end-to-end-flow'].rating).toBe('degraded');
  });

  it('Scout transport-death → ideation-quality broken; draft-force-start → queen-plan-selection degraded', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        scout: { ...BASE.scout, transportDeath: true, ideasInWindow: 0 },
        plans: { ...BASE.plans, startedDraft: 2 },
      }),
    );
    expect(r['ideation-quality'].rating).toBe('broken');
    expect(r['queen-plan-selection'].rating).toBe('degraded');
  });

  it('excessive watchdog fires → watchdog-determinism degraded', () => {
    const r = synthesizeCoordinationScorecard(mkHealth({ watchdog: { ...BASE.watchdog, fires24h: 82 } }));
    expect(r['watchdog-determinism'].rating).toBe('degraded');
  });

  it('judgment-only criteria are honestly unknown', () => {
    const r = synthesizeCoordinationScorecard(mkHealth());
    for (const k of ['parallel-distribution', 'tool-utilization', 'coordination-comms', 'bee-observation-quality']) {
      expect(r[k].rating).toBe('unknown');
    }
    expect(r['overwatch-observation-quality'].rating).toBe('unknown');
  });

  it('null (unread) panels degrade to unknown, never throw', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: null, bees: null, queen: null, watchdog: null, scout: null, plans: null }),
    );
    assertWellFormed(r);
    expect(r['end-to-end-flow'].rating).toBe('unknown');
    expect(r['watchdog-determinism'].rating).toBe('unknown');
  });
});

// ── the end-check (turn-end seam) ───────────────────────────────────────────────

function deps(over: Partial<OverwatchScorecardEndCheckDeps> = {}): {
  d: OverwatchScorecardEndCheckDeps;
  captured: { capture: unknown[]; fires: unknown[] };
} {
  const captured = { capture: [] as unknown[], fires: [] as unknown[] };
  const d: OverwatchScorecardEndCheckDeps = {
    enabled: async () => true,
    started: async () => true,
    controlState: async () => ({ lastWakeAt: '2026-06-21T17:00:00.000Z', hiveSlug: 'papercusp' }),
    freshness: (async () => ({ status: 'stale' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    computeHealth: async () => mkHealth(),
    capture: (async (input: unknown) => {
      captured.capture.push(input);
      return { ok: true, created: true, possibleDuplicates: [] };
    }) as unknown as OverwatchScorecardEndCheckDeps['capture'],
    recordFire: async (...a: unknown[]) => {
      captured.fires.push(a);
    },
    ...over,
  };
  return { d, captured };
}

const opts = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' };

describe('overwatchScorecardEndCheck', () => {
  it('flag off → skipped, nothing filed', async () => {
    const { d, captured } = deps({ enabled: async () => false });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
    expect(captured.fires).toHaveLength(0);
  });

  it('not started → skipped', async () => {
    const { d, captured } = deps({ started: async () => false });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
  });

  it('agent emitted a complete scorecard (fresh) → skipped, no floor', async () => {
    const { d, captured } = deps({
      freshness: (async () => ({ status: 'fresh' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
    expect(captured.fires).toHaveLength(0);
  });

  it('agent skipped (stale) → synthesizes a complete, synthesized-marked floor + records a fire', async () => {
    const { d, captured } = deps();
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('synthesized');
    expect(captured.capture).toHaveLength(1);
    expect(captured.fires).toHaveLength(1);
    const input = captured.capture[0] as {
      lane: string;
      payloadExtra: { observation: { rubricRef: string; synthesized: boolean; ratings: Record<string, unknown> } };
    };
    expect(input.lane).toBe('observation');
    const obs = input.payloadExtra.observation;
    expect(obs.rubricRef).toBe(COORDINATION_RUBRIC_REF);
    expect(obs.synthesized).toBe(true);
    expect(Object.keys(obs.ratings).sort()).toEqual([...COORDINATION_CRITERIA].sort());
  });

  it('asks freshness for AGENT scorecards only (includeSynthesized:false)', async () => {
    let seen: { includeSynthesized?: boolean } | null = null;
    const { d } = deps({
      freshness: (async (f: { includeSynthesized?: boolean }) => {
        seen = f;
        return { status: 'stale' };
      }) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    await overwatchScorecardEndCheck(opts, d);
    expect(seen!.includeSynthesized).toBe(false);
  });

  it('partial-only agent emission → still synthesizes the floor', async () => {
    const { d, captured } = deps({
      freshness: (async () => ({ status: 'partial-only' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('synthesized');
    expect(captured.capture).toHaveLength(1);
  });

  it('fail-soft: computeHealth throwing yields outcome:error, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d } = deps({
      computeHealth: async () => {
        throw new Error('brief read failed');
      },
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('error');
    expect(res.reason).toContain('brief read failed');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fail-soft: capture throwing yields outcome:error, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d } = deps({
      capture: (async () => {
        throw new Error('capture exploded');
      }) as unknown as OverwatchScorecardEndCheckDeps['capture'],
    });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('error');
    warn.mockRestore();
  });
});
