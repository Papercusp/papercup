/**
 * cadence-matrix.test.ts — scout-loop-test-plan P-005: the full table-driven
 * decision matrix over the Scout cadence/scheduling gates.
 *
 * Part 1 pins {@link shouldRunScoutCycle} as an exhaustive idle × friction ×
 * elapsed table, including every boundary value (exactly-at-threshold idle,
 * exactly-at-threshold friction, elapsed exactly at the min/friction/heartbeat
 * edges) and the priority order (friction > floor > idle > heartbeat).
 *
 * Part 2 pins the {@link runScoutTick} composition as a cadence × autoloop-
 * circuit × budget-remaining matrix, wiring the REAL {@link evaluateFireGate}
 * (closed / backoff / circuit-open / half-open probe) as the fire-gate and the
 * REAL {@link checkScoutBudget} inside the injected cycle — so all four gate
 * dimensions are exercised through the production decision path with zero IO.
 *
 * Deterministic: fixed epoch clock injected via ScoutCadenceState.nowMs /
 * evaluateFireGate's `now` param — no timers at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldRunScoutCycle,
  type ScoutCadenceOptions,
  type ScoutCadenceReason,
  type ScoutCadenceState,
} from './cadence';
import { runScoutTick, type ScoutTickDeps, type ScoutTickResult } from './scheduler';
import { checkScoutBudget } from './budget';
import { evaluateFireGate, type FireState } from '../autoloop';
import type { ScoutTickRecord } from './tick-ledger';

const NOW = Date.parse('2026-06-08T12:00:00Z');

// Defaults under test (cadence.ts DEFAULTS): minInterval 3600s, friction floor
// min(minInterval, 900) = 900s, heartbeat ceiling 3600s (== minInterval, owner-set
// hourly 2026-06-18), idleThreshold 0.5, frictionThreshold 3.
const MIN = 3600;
const FRICTION_FLOOR = 900;
// An EXPLICIT long ceiling (the pre-2026-06-18 default). Rows that isolate the
// "below the heartbeat ceiling → no-trigger" window opt into it so they test the
// gate LOGIC independent of the now-hourly default. The default's own hourly
// heartbeat is pinned by the "default heartbeat is hourly" rows below.
const MAX = 86400;
const LONG = { maxIntervalSec: MAX } as const;

function cadenceState(idle: number, friction: number, elapsedSec: number | null): ScoutCadenceState {
  return {
    idleRatio: idle,
    frictionSignals: friction,
    lastRunAtMs: elapsedSec == null ? null : NOW - elapsedSec * 1000,
    nowMs: NOW,
  };
}

interface CadenceRow {
  name: string;
  idle: number;
  friction: number;
  /** Seconds since the last run; null = never ran. */
  elapsedSec: number | null;
  opts?: ScoutCadenceOptions;
  fire: boolean;
  reason: ScoutCadenceReason;
  retryAfterSec?: number;
}

const CADENCE_MATRIX: CadenceRow[] = [
  // ── never-run column (elapsed = ∞) ─────────────────────────────────────────
  { name: 'never run × saturated × quiet → heartbeat (first tick never stalls)', idle: 0, friction: 0, elapsedSec: null, fire: true, reason: 'heartbeat' },
  { name: 'never run × idle EXACTLY at threshold → idle-capacity (>= boundary)', idle: 0.5, friction: 0, elapsedSec: null, fire: true, reason: 'idle-capacity' },
  { name: 'never run × idle a hair under threshold → falls through to heartbeat', idle: 0.49999, friction: 0, elapsedSec: null, fire: true, reason: 'heartbeat' },
  { name: 'never run × friction EXACTLY at threshold → friction-triggered (>= boundary)', idle: 0, friction: 3, elapsedSec: null, fire: true, reason: 'friction-triggered' },
  { name: 'never run × friction one under threshold × idle over → idle-capacity', idle: 1, friction: 2, elapsedSec: null, fire: true, reason: 'idle-capacity' },
  { name: 'never run × BOTH triggers over threshold → friction outranks idle', idle: 1, friction: 5, elapsedSec: null, fire: true, reason: 'friction-triggered' },

  // ── idle × min-interval floor boundaries ───────────────────────────────────
  { name: 'idle 1 × elapsed one second shy of the floor → min-interval, retry 1', idle: 1, friction: 0, elapsedSec: MIN - 1, fire: false, reason: 'min-interval', retryAfterSec: 1 },
  { name: 'idle EXACTLY at threshold × elapsed EXACTLY at the floor → idle-capacity (double boundary)', idle: 0.5, friction: 0, elapsedSec: MIN, fire: true, reason: 'idle-capacity' },
  // (LONG ceiling so "at the floor but below the heartbeat" is a real window —
  //  under the default hourly ceiling MIN==MAX, so these would heartbeat-fire.)
  { name: 'idle a hair under threshold × elapsed at the floor (long ceiling) → no-trigger', idle: 0.49999, friction: 0, elapsedSec: MIN, opts: LONG, fire: false, reason: 'no-trigger' },
  { name: 'floor passed but nothing to fire (idle 0, friction 0, long ceiling) → no-trigger', idle: 0, friction: 0, elapsedSec: MIN, opts: LONG, fire: false, reason: 'no-trigger' },

  // ── DEFAULT hourly heartbeat (owner-set 2026-06-18: maxInterval == minInterval) ──
  { name: 'DEFAULT hourly: idle below threshold × elapsed at the floor → heartbeat (no blind dark)', idle: 0.49999, friction: 0, elapsedSec: MIN, fire: true, reason: 'heartbeat' },
  { name: 'DEFAULT hourly: quiet hive × elapsed at the floor → heartbeat', idle: 0, friction: 0, elapsedSec: MIN, fire: true, reason: 'heartbeat' },
  { name: 'DEFAULT hourly: one second shy of the floor/ceiling → min-interval (still ~hourly, not every tick)', idle: 0, friction: 0, elapsedSec: MIN - 1, fire: false, reason: 'min-interval', retryAfterSec: 1 },

  // ── heartbeat ceiling boundaries (explicit LONG ceiling) ─────────────────────
  { name: 'one second shy of the heartbeat ceiling → no-trigger', idle: 0.49999, friction: 2, elapsedSec: MAX - 1, opts: LONG, fire: false, reason: 'no-trigger' },
  { name: 'elapsed EXACTLY at the heartbeat ceiling → heartbeat (>= boundary)', idle: 0.49999, friction: 2, elapsedSec: MAX, opts: LONG, fire: true, reason: 'heartbeat' },
  { name: 'past the ceiling × idle at threshold → idle-capacity outranks heartbeat', idle: 0.5, friction: 0, elapsedSec: MAX + 3600, opts: LONG, fire: true, reason: 'idle-capacity' },
  { name: 'past the ceiling × friction at threshold → friction outranks heartbeat', idle: 0, friction: 3, elapsedSec: MAX + 3600, opts: LONG, fire: true, reason: 'friction-triggered' },

  // ── friction floor boundaries + priority ───────────────────────────────────
  { name: 'friction at threshold × one second shy of the friction floor → min-interval, retry 1', idle: 0, friction: 3, elapsedSec: FRICTION_FLOOR - 1, fire: false, reason: 'min-interval', retryAfterSec: 1 },
  { name: 'friction at threshold × elapsed EXACTLY at the friction floor → friction-triggered', idle: 0, friction: 3, elapsedSec: FRICTION_FLOOR, fire: true, reason: 'friction-triggered' },
  { name: 'friction inside the NORMAL floor but past the friction floor → friction-triggered (bypass)', idle: 0, friction: 3, elapsedSec: 1800, fire: true, reason: 'friction-triggered' },
  { name: 'huge friction does NOT bypass the friction floor (magnitude is not urgency)', idle: 0, friction: 1000, elapsedSec: FRICTION_FLOOR - 1, fire: false, reason: 'min-interval', retryAfterSec: 1 },
  { name: 'friction-shaped tick at zero elapsed → withheld by the FRICTION floor (900s, not 3600s)', idle: 1, friction: 3, elapsedSec: 0, fire: false, reason: 'min-interval', retryAfterSec: FRICTION_FLOOR },
  { name: 'sub-threshold friction is no trigger even with a huge backlog window (long ceiling)', idle: 0.2, friction: 2, elapsedSec: 7200, opts: LONG, fire: false, reason: 'no-trigger' },

  // ── custom-option edges ────────────────────────────────────────────────────
  { name: 'frictionThreshold 0 makes EVERY tick friction-shaped (outranks idle)', idle: 1, friction: 0, elapsedSec: 1000, opts: { frictionThreshold: 0 }, fire: true, reason: 'friction-triggered' },
  { name: 'idleThreshold 0 → a fully-saturated fleet still idle-fires past the floor', idle: 0, friction: 0, elapsedSec: MIN, opts: { idleThreshold: 0 }, fire: true, reason: 'idle-capacity' },
  { name: 'idleThreshold above 1 can never idle-fire (falls to no-trigger, long ceiling)', idle: 1, friction: 0, elapsedSec: 7200, opts: { idleThreshold: 1.1, maxIntervalSec: MAX }, fire: false, reason: 'no-trigger' },
  { name: 'floor DOMINATES a shorter ceiling (max < min): inside the floor → min-interval', idle: 0, friction: 0, elapsedSec: 1800, opts: { maxIntervalSec: 600 }, fire: false, reason: 'min-interval', retryAfterSec: 1800 },
  { name: 'floor dominates a shorter ceiling: heartbeat only fires once past the FLOOR', idle: 0, friction: 0, elapsedSec: MIN, opts: { maxIntervalSec: 600 }, fire: true, reason: 'heartbeat' },
];

describe('shouldRunScoutCycle — decision matrix (P-005)', () => {
  it.each(CADENCE_MATRIX)('$name', (row) => {
    const v = shouldRunScoutCycle(cadenceState(row.idle, row.friction, row.elapsedSec), row.opts);
    expect(v.fire).toBe(row.fire);
    expect(v.reason).toBe(row.reason);
    if (row.retryAfterSec !== undefined) expect(v.retryAfterSec).toBe(row.retryAfterSec);
    else expect(v.retryAfterSec).toBeUndefined();
  });
});

// ── Part 2: the runScoutTick composition matrix ───────────────────────────────
// cadence × REAL autoloop circuit states × budget-remaining, through the
// production decision path (evaluateFireGate as the fire-gate, checkScoutBudget
// inside the injected cycle). Autoloop knobs pinned to their defaults
// (base 60s, cap 3600s, circuit threshold 8) by clearing the env overrides —
// same idiom as autoloop.test.ts.

const AUTOLOOP_ENV = [
  'PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC',
  'PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC',
  'PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD',
] as const;

const firedAgo = (sec: number) => new Date(NOW - sec * 1000);

interface TickCase {
  name: string;
  idle: number;
  friction: number;
  elapsedSec: number | null;
  /** Autoloop fire-state row driving the REAL evaluateFireGate; null = no row (circuit closed). */
  fireState: FireState | null;
  /** USD already spent when the cycle consults its budget gate (default 0 = fresh). */
  spentUsd?: number;
  expect: {
    fired: boolean;
    reason: ScoutTickResult['reason'];
    retryAfterSec?: number;
    cyclesRun: number;
    routedCount?: number;
    /** How often the circuit gate was consulted (0 ⇒ cadence outranked it). */
    gateChecks: number;
    /** The autoloop verdict reason recorded on a gated tick ('backoff' | 'circuit-open'). */
    circuitDetailReason?: string;
    /** The cycle's stop reason recorded on a ran tick (budget dimension). */
    stop?: string;
  };
}

const TICK_MATRIX: TickCase[] = [
  {
    name: 'idle fire × circuit closed (no fire-state row) × fresh budget → cycle runs, idea routed',
    idle: 1, friction: 0, elapsedSec: null, fireState: null,
    expect: { fired: true, reason: 'idle-capacity', cyclesRun: 1, routedCount: 1, gateChecks: 1 },
  },
  {
    name: 'double boundary through the composition: idle exactly at threshold × elapsed exactly at floor → fires',
    idle: 0.5, friction: 0, elapsedSec: MIN, fireState: null,
    expect: { fired: true, reason: 'idle-capacity', cyclesRun: 1, routedCount: 1, gateChecks: 1 },
  },
  {
    name: 'friction fire × backoff mid-window (1 error, fired 30s ago, base 60s) → circuit-gated, retry 30',
    idle: 0, friction: 5, elapsedSec: null,
    fireState: { lastFiredAt: firedAgo(30), consecutiveErrors: 1 },
    expect: { fired: false, reason: 'circuit', retryAfterSec: 30, cyclesRun: 0, gateChecks: 1, circuitDetailReason: 'backoff' },
  },
  {
    name: 'friction fire × backoff elapsed EXACTLY at the required window (1 error, 60s ago) → fires',
    idle: 0, friction: 5, elapsedSec: null,
    fireState: { lastFiredAt: firedAgo(60), consecutiveErrors: 1 },
    expect: { fired: true, reason: 'friction-triggered', cyclesRun: 1, routedCount: 1, gateChecks: 1 },
  },
  {
    name: 'idle fire × errors one under the circuit threshold (7) → still BACKOFF, capped at 3600s',
    idle: 1, friction: 0, elapsedSec: null,
    fireState: { lastFiredAt: firedAgo(0), consecutiveErrors: 7 },
    expect: { fired: false, reason: 'circuit', retryAfterSec: 3600, cyclesRun: 0, gateChecks: 1, circuitDetailReason: 'backoff' },
  },
  {
    name: 'idle fire × circuit OPEN (errors at threshold 8, fired 1s ago) → gated, retry ≈ cap window',
    idle: 1, friction: 0, elapsedSec: null,
    fireState: { lastFiredAt: firedAgo(1), consecutiveErrors: 8 },
    expect: { fired: false, reason: 'circuit', retryAfterSec: 3599, cyclesRun: 0, gateChecks: 1, circuitDetailReason: 'circuit-open' },
  },
  {
    name: 'idle fire × circuit HALF-OPEN (errors ≥ threshold, cap window EXACTLY elapsed) → one probe cycle runs',
    idle: 1, friction: 0, elapsedSec: null,
    fireState: { lastFiredAt: firedAgo(3600), consecutiveErrors: 8 },
    expect: { fired: true, reason: 'idle-capacity', cyclesRun: 1, routedCount: 1, gateChecks: 1 },
  },
  {
    name: 'cadence min-interval × circuit OPEN → cadence outranks: circuit gate NEVER consulted',
    idle: 1, friction: 0, elapsedSec: 1,
    fireState: { lastFiredAt: firedAgo(1), consecutiveErrors: 8 },
    expect: { fired: false, reason: 'min-interval', cyclesRun: 0, gateChecks: 0 },
  },
  {
    name: 'friction fire × circuit closed × ZERO budget remaining (spent = cap) → tick fires, cycle stops fan-out gracefully',
    idle: 0, friction: 5, elapsedSec: null, fireState: null, spentUsd: 1.0, // = DEFAULT_SCOUT_BUDGET.maxCostUsd
    expect: { fired: true, reason: 'friction-triggered', cyclesRun: 1, routedCount: 0, gateChecks: 1, stop: 'budget-exhausted' },
  },
  {
    name: 'idle fire × circuit closed × a hair of budget remaining (strictly under the cap) → still routes',
    idle: 1, friction: 0, elapsedSec: null, fireState: null, spentUsd: 0.999999,
    expect: { fired: true, reason: 'idle-capacity', cyclesRun: 1, routedCount: 1, gateChecks: 1 },
  },
];

describe('runScoutTick — cadence × circuit × budget matrix (P-005)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of AUTOLOOP_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of AUTOLOOP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function tickDeps(c: TickCase) {
    const calls = { cycles: 0, gateChecks: 0, fire: [] as string[], ticks: [] as ScoutTickRecord[] };
    const deps: ScoutTickDeps = {
      readCadenceState: async () => cadenceState(c.idle, c.friction, c.elapsedSec),
      runCycle: async ({ budget }) => {
        calls.cycles += 1;
        // The REAL per-cycle budget gate, exactly as a cycle consults it before
        // fanning out: zero-remaining ⇒ stop gracefully with nothing routed.
        const gate = checkScoutBudget(c.spentUsd ?? 0, budget);
        if (!gate.proceed) return { provenance: [], stop: 'budget-exhausted' };
        return {
          provenance: [{ ideaId: 'i1', lens: 'analogical' as const, rail: 'gym' as const, routedRef: 'gym:1' }],
          costUsd: 0.05,
        };
      },
      persistRouted: async () => {},
      recordFire: async (o) => {
        calls.fire.push(o);
      },
      recordTick: async (rec) => {
        calls.ticks.push(rec);
      },
      newCycleId: () => 'cyc-m',
      // The REAL autoloop gate over the case's fire-state, the same adaptation
      // buildScoutTickDeps performs over checkFireGate.
      fireGate: async () => {
        calls.gateChecks += 1;
        const v = evaluateFireGate(c.fireState, new Date(NOW));
        return { allow: v.allow, reason: v.reason, retryAfterSec: v.retryAfterSec };
      },
    };
    return { deps, calls };
  }

  it.each(TICK_MATRIX)('$name', async (c) => {
    const { deps, calls } = tickDeps(c);
    const r = await runScoutTick(deps);

    expect(r.fired).toBe(c.expect.fired);
    expect(r.reason).toBe(c.expect.reason);
    if (c.expect.retryAfterSec !== undefined) expect(r.retryAfterSec).toBe(c.expect.retryAfterSec);
    if (c.expect.routedCount !== undefined) expect(r.routedCount).toBe(c.expect.routedCount);
    expect(calls.cycles).toBe(c.expect.cyclesRun);
    expect(calls.gateChecks).toBe(c.expect.gateChecks);

    // A withheld tick must never record a fire attempt; a fired one exactly attempt+ok.
    expect(calls.fire).toEqual(c.expect.fired ? ['attempt', 'ok'] : []);

    // Every exit records exactly one tick row naming what happened.
    expect(calls.ticks).toHaveLength(1);
    const tick = calls.ticks[0];
    if (c.expect.fired) {
      expect(tick.status).toBe('ran');
      if (c.expect.stop !== undefined) expect(tick.detail).toMatchObject({ stop: c.expect.stop });
    } else {
      expect(tick.status).toBe('gated');
      expect(tick.gate).toBe(r.reason === 'circuit' ? 'circuit' : r.reason);
      if (c.expect.circuitDetailReason !== undefined) {
        expect(tick.detail).toMatchObject({ reason: c.expect.circuitDetailReason });
      }
    }
  });
});
