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
  checkOverwatchEmissionWedge,
  WEDGE_STALE_CADENCE_MULTIPLE,
  PULSE_WINDOW_MS,
  type ScorecardEmissionPulseDeps,
  type OverwatchEmissionWedgeDeps,
  type EmissionWedgeEscalation,
} from './scorecard-emission-pulse';
import {
  COORDINATION_CRITERIA,
  COORDINATION_RUBRIC_REF,
} from './overwatch/scorecard-backstop';
import type { SystemHealth } from './system-health/types';
import type { ScorecardFreshness } from './scorecard-freshness';
import type { OverwatchLiveness } from './overwatch/brief-types';

const EMPTY_HEALTH = { panels: {}, evaluatedAt: 0 } as unknown as SystemHealth;

function freshnessResult(over: Partial<ScorecardFreshness> = {}): ScorecardFreshness {
  return {
    rubricRef: COORDINATION_RUBRIC_REF,
    since: '2026-07-04T00:00:00Z',
    status: 'stale',
    rubricKnown: true,
    emitted: false,
    complete: false,
    count: 0,
    partialCount: 0,
    lastEmittedAt: null,
    lastCompleteAt: null,
    latestMissingKeys: [],
    latestExtraKeys: [],
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
      controlState: async () => ({ potSlug: 'papercusp' }),
      freshness: vi.fn(async () => freshnessResult()),
      computeHealth: async () => EMPTY_HEALTH,
      capture: capture as never,
      recordFire,
      toolUtilizationGrade: async () => undefined,
      // WI-2977 coalesce deps: stub hermetic (the defaults query live PG — on a
      // dev box with a REAL standing pulse floor the coalesce branch swallows
      // `capture` and every assertion below silently inverts).
      findOpenPulseFloor: async () => null,
      bumpPulseRepeat: vi.fn(async () => {}) as never,
      ...over,
    },
  };
}

describe('runScorecardEmissionPulse', () => {
  it('unknown rubric → skipped without filing a floor', async () => {
    const { deps, capture } = mkDeps({
      freshness: async () => freshnessResult({ status: 'unknown-rubric', rubricKnown: false }),
    });
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('unknown');
    expect(capture).not.toHaveBeenCalled();
  });

  it('empty window → files the floor (all 15 criteria, synthesized, synthSource scheduled-pulse) + records the fire', async () => {
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
    const { deps, capture } = mkDeps({ controlState: async () => ({ potSlug: 'papercusp' }) });
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
    const { deps, capture } = mkDeps({ controlState: async () => ({ potSlug: null }) });
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

  describe('WI-2977 coalescing — a standing open pulse floor dedups the ANCHOR, never the card', () => {
    it('an existing OPEN pulse floor → STILL emits the card, bumps the repeat stamp, reports coalescedInto', async () => {
      const bumpPulseRepeat = vi.fn(async () => {});
      const { deps, capture, recordFire } = mkDeps({
        findOpenPulseFloor: async (key) => {
          expect(key).toBe('scorecard-pulse:papercusp');
          return { id: 'EI-1234', payload: { pulseRepeat: { count: 2, firstFiredAt: '2026-07-04T00:00:00Z', lastFiredAt: '2026-07-04T02:00:00Z' } } };
        },
        bumpPulseRepeat,
      });
      const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
      expect(r.outcome).toBe('filed');
      expect(r.coalescedInto).toBe('EI-1234');
      expect(r.reason).toContain('coalesced onto standing open pulse floor EI-1234');
      expect(r.reason).toContain('repeat 3');
      // WI-10000010: the CARD is the data layer and is owed on every empty-window
      // tick. This assertion used to read `not.toHaveBeenCalled()` — that line WAS
      // the defect, written down: coalescing the anchor silently coalesced the card.
      expect(capture).toHaveBeenCalledTimes(1);
      const arg = capture.mock.calls[0][0] as Record<string, any>;
      expect(arg.payloadExtra.observation.rubricRef).toBe(COORDINATION_RUBRIC_REF);
      expect(arg.payloadExtra.observation.synthesized).toBe(true);
      // ...but it must NOT carry a second watchdogKey, or the anchor forks and the
      // duplicate-open-EI pile-up WI-2977 removed comes straight back.
      expect(arg.payloadExtra.watchdogKey).toBeUndefined();
      expect(bumpPulseRepeat).toHaveBeenCalledWith('EI-1234', 2, '2026-07-04T00:00:00Z');
      expect(recordFire).toHaveBeenCalledTimes(1);
    });

    it('WI-10000010: a LONG outage never silences the floor — every tick emits, and the anchor never forks', async () => {
      // The regression this pins. WI-2977 returned ABOVE the emit, so once the anchor
      // was open and the previous card aged out of the 1h window, no card could ever
      // land again — and because no card lands, the window stays empty and the anchor
      // stays open, so the trap is self-perpetuating rather than self-healing.
      // Measured in production: EI-7857 (`scorecard-pulse:papercusp`) open since
      // 2026-07-06 with pulseRepeat.count=3550 — 3550 ticks, 0 cards, and every one
      // of them reported outcome:'filed'.
      const bumpPulseRepeat = vi.fn(async () => {});
      const { deps, capture } = mkDeps({
        findOpenPulseFloor: async () => ({
          id: 'EI-7857',
          payload: { pulseRepeat: { count: 3550, firstFiredAt: '2026-07-06T13:13:51.129Z', lastFiredAt: '2026-09-06T10:46:56.244Z' } },
        }),
        bumpPulseRepeat,
      });
      for (let tick = 0; tick < 3; tick++) {
        const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
        expect(r.outcome).toBe('filed');
        expect(r.coalescedInto).toBe('EI-7857');
      }
      expect(capture).toHaveBeenCalledTimes(3);
      for (const call of capture.mock.calls) {
        expect((call[0] as Record<string, any>).payloadExtra.watchdogKey).toBeUndefined();
      }
      expect(bumpPulseRepeat).toHaveBeenCalledTimes(3);
    });

    it('no existing open pulse floor → files a fresh floor AND anchors it with the watchdogKey', async () => {
      const { deps, capture } = mkDeps({ findOpenPulseFloor: async () => null });
      const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
      expect(r.outcome).toBe('filed');
      expect(r.coalescedInto).toBeUndefined();
      expect(capture).toHaveBeenCalledTimes(1);
      // The FIRST card of an outage is the anchor — without this the standing-open
      // dedup has nothing to match and every tick re-files a brand-new open EI.
      expect((capture.mock.calls[0][0] as Record<string, any>).payloadExtra.watchdogKey).toBe('scorecard-pulse:papercusp');
    });

    it('findOpenPulseFloor throwing → caught, falls through to filing fresh (fail-soft)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { deps, capture } = mkDeps({
          findOpenPulseFloor: async () => {
            throw new Error('pg down');
          },
        });
        const r = await runScorecardEmissionPulse({ workspaceId: 'ws' }, deps);
        expect(r.outcome).toBe('filed');
        expect(r.coalescedInto).toBeUndefined();
        expect(capture).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('readPulseRepeatCount is defensive against absent/malformed payload', async () => {
      const { readPulseRepeatCount } = await import('./scorecard-emission-pulse');
      expect(readPulseRepeatCount(null)).toBe(0);
      expect(readPulseRepeatCount(undefined)).toBe(0);
      expect(readPulseRepeatCount({})).toBe(0);
      expect(readPulseRepeatCount({ pulseRepeat: null })).toBe(0);
      expect(readPulseRepeatCount({ pulseRepeat: { count: 'nope' } })).toBe(0);
      expect(readPulseRepeatCount({ pulseRepeat: { count: 5 } })).toBe(5);
    });
  });
});

// ── WI-3777: the cadence-miss ESCALATION ─────────────────────────────────────────
//
// The contract under test: escalate ONLY an actionable emission-wedge verdict
// (loop-dead / agent-skipping) as a debounced owner advisory; a benign
// stopped/paused/disabled supervisor stays floor-only (never alarms); the freshness
// read counts ONLY complete agent cards (synthesized floors must not mask a wedge);
// a never-fired loop right after start is the pre-first-fire window, not a wedge.
// Fully deps-injected — no PG / flags / coord IO / vi.mock.

function livenessResult(over: Partial<OverwatchLiveness> = {}): OverwatchLiveness {
  return {
    potSlug: 'papercusp',
    started: true,
    flagEnabled: true,
    cadenceSec: 600,
    lastRunAt: '2026-07-10T18:00:00Z',
    lastStatus: 'ok',
    consecutiveErrors: 0,
    ageMs: 30_000,
    inFlight: false,
    nextRunAt: '2026-07-10T18:10:00Z',
    nextRunInMs: 570_000,
    alive: true,
    stale: false,
    recentRuns: [],
    ...over,
  };
}

function mkWedgeDeps(over: Partial<OverwatchEmissionWedgeDeps> = {}): {
  deps: OverwatchEmissionWedgeDeps;
  escalate: ReturnType<typeof vi.fn>;
  recordFire: ReturnType<typeof vi.fn>;
  freshness: ReturnType<typeof vi.fn>;
} {
  const escalate = vi.fn(async (_i: EmissionWedgeEscalation) => {});
  const recordFire = vi.fn(async () => {});
  // Default: loop ALIVE + no complete card in-window → the agent-skipping wedge.
  const freshness = vi.fn(async () => freshnessResult({ status: 'stale' }));
  return {
    escalate,
    recordFire,
    freshness,
    deps: {
      liveness: (async () => livenessResult()) as never,
      freshness: freshness as never,
      escalate,
      recordFire,
      ...over,
    },
  };
}

describe('checkOverwatchEmissionWedge (WI-3777 cadence-miss escalation)', () => {
  it('loop ALIVE but no complete card in-window → escalates agent-skipping (once) + records the fire', async () => {
    const { deps, escalate, recordFire } = mkWedgeDeps();
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('escalated');
    expect(r.verdict).toBe('agent-skipping');
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledTimes(1);
    const arg = escalate.mock.calls[0][0] as EmissionWedgeEscalation;
    expect(arg.sourceHive).toBe('papercusp');
    expect(arg.verdict).toBe('agent-skipping');
  });

  it('loop STALE with a prior fire (the 08:32Z signature) → escalates loop-dead', async () => {
    const { deps, escalate } = mkWedgeDeps({
      liveness: (async () =>
        livenessResult({ alive: false, stale: true, lastRunAt: '2026-07-10T17:30:00Z', ageMs: 30 * 60_000 })) as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('escalated');
    expect(r.verdict).toBe('loop-dead');
    expect(escalate).toHaveBeenCalledTimes(1);
    expect((escalate.mock.calls[0][0] as EmissionWedgeEscalation).lastRunAt).toBe('2026-07-10T17:30:00Z');
  });

  it('loop cadence reads STALE while a bounded turn is in flight → skipped, not a false wedge', async () => {
    const { deps, escalate, recordFire } = mkWedgeDeps({
      liveness: (async () =>
        livenessResult({
          alive: false,
          stale: true,
          lastStatus: 'firing',
          ageMs: 300_000,
          inFlight: true,
        })) as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.verdict).toBe('turn-in-flight');
    expect(escalate).not.toHaveBeenCalled();
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('the startup-race guard: loop NEVER fired (ageMs null) → skipped, NOT a wedge, no escalation', async () => {
    const { deps, escalate, recordFire } = mkWedgeDeps({
      liveness: (async () =>
        livenessResult({ alive: false, stale: true, lastRunAt: null, ageMs: null })) as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.verdict).toBe('loop-dead');
    expect(r.reason).toContain('never fired');
    expect(escalate).not.toHaveBeenCalled();
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('healthy: a COMPLETE card in-window → skipped (no wedge), no escalation', async () => {
    const { deps, escalate } = mkWedgeDeps({
      freshness: (async () =>
        freshnessResult({ status: 'fresh', emitted: true, complete: true, count: 1, lastCompleteAt: '2026-07-10T18:05:00Z' })) as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.verdict).toBe('fresh');
    expect(escalate).not.toHaveBeenCalled();
  });

  it('benign STOPPED supervisor (not started) → skipped floor-only; freshness never read', async () => {
    const freshness = vi.fn(async () => freshnessResult());
    const { deps, escalate } = mkWedgeDeps({
      liveness: (async () => livenessResult({ started: false, alive: false, stale: false })) as never,
      freshness: freshness as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('not started');
    expect(escalate).not.toHaveBeenCalled();
    expect(freshness).not.toHaveBeenCalled();
  });

  it('flag off → skipped (benign), no escalation, freshness never read', async () => {
    const freshness = vi.fn(async () => freshnessResult());
    const { deps, escalate } = mkWedgeDeps({
      liveness: (async () => livenessResult({ flagEnabled: false })) as never,
      freshness: freshness as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('disabled');
    expect(escalate).not.toHaveBeenCalled();
    expect(freshness).not.toHaveBeenCalled();
  });

  it('no hive configured → skipped', async () => {
    const { deps, escalate } = mkWedgeDeps({
      liveness: (async () => livenessResult({ potSlug: null })) as never,
    });
    const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('no hive');
    expect(escalate).not.toHaveBeenCalled();
  });

  it('freshness is read for COMPLETE cards only (includeSynthesized:false) over the 2×-cadence window', async () => {
    const { deps, freshness } = mkWedgeDeps();
    await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({
        rubricRef: COORDINATION_RUBRIC_REF,
        sourceHive: 'papercusp',
        lookbackMs: 600 * 1000 * WEDGE_STALE_CADENCE_MULTIPLE,
        includeSynthesized: false,
      }),
    );
  });

  it('a throwing escalator → outcome error, NEVER a throw into the scheduler', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { deps } = mkWedgeDeps({
        escalate: async () => {
          throw new Error('coord down');
        },
      });
      const r = await checkOverwatchEmissionWedge({ workspaceId: 'ws' }, deps);
      expect(r.outcome).toBe('error');
      expect(r.reason).toContain('coord down');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
