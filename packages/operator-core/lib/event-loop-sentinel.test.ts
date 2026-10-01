import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decideLoopSentinelAction,
  initialLoopSentinelState,
  type LoopSentinelAction,
  type LoopSentinelObservation,
  type LoopSentinelState,
  type LoopSentinelThresholds,
} from './event-loop-sentinel';

/**
 * Thresholds shaped like the real deployment: the sentinel ticks every 1s, the
 * main thread beats every 1s, and a loop must be stuck ~10s across 3 ticks
 * before we kill. Deliberately NOT the defaults — a test that shares its
 * subject's defaults cannot catch a bad default.
 */
const T: LoopSentinelThresholds = {
  wedgeAfterMs: 10_000,
  observationsToAct: 3,
  startupGraceMs: 30_000,
  warnAfterMs: 5_000,
};

/** Drive a run of observations through the decider, returning every action. */
function run(
  state: LoopSentinelState,
  observations: LoopSentinelObservation[],
  thresholds: LoopSentinelThresholds = T,
): { actions: LoopSentinelAction[]; state: LoopSentinelState } {
  const actions: LoopSentinelAction[] = [];
  let s = state;
  for (const obs of observations) {
    const d = decideLoopSentinelAction(s, obs, thresholds);
    s = d.state;
    actions.push(d.action);
  }
  return { actions, state: s };
}

/** A loop that is turning: the counter advances once per tick. */
function healthyTicks(fromMs: number, count: number, stepMs = 1_000, fromCounter = 0) {
  return Array.from({ length: count }, (_, i) => ({
    counter: fromCounter + i + 1,
    nowMs: fromMs + (i + 1) * stepMs,
  }));
}

/**
 * A loop that has STOPPED: the counter is frozen while time advances.
 *
 * The frozen value MUST be the state's current `lastCounter` — a freeze at some
 * other value reads to the decider as a counter that MOVED (correctly: it did),
 * so the first tick reports `ok` and the wedge never accrues. Deriving it from
 * the state makes that impossible to get wrong, rather than a number to keep in
 * sync by hand.
 */
function frozenAfter(
  state: LoopSentinelState,
  fromMs: number,
  count: number,
  stepMs = 1_000,
) {
  return Array.from({ length: count }, (_, i) => ({
    counter: state.lastCounter,
    nowMs: fromMs + (i + 1) * stepMs,
  }));
}

/** Past the startup grace window, with a heartbeat already confirmed. */
function settledState(): LoopSentinelState {
  const s0 = initialLoopSentinelState(0, 0);
  return run(s0, healthyTicks(0, 40)).state; // 40s elapsed > 30s grace
}

describe('decideLoopSentinelAction — a turning loop is never touched', () => {
  it('a counter that advances reports ok and latches sawHeartbeat', () => {
    const { actions, state } = run(initialLoopSentinelState(0, 0), healthyTicks(0, 5));
    expect(actions.every((a) => a.kind === 'ok')).toBe(true);
    expect(state.sawHeartbeat).toBe(true);
    expect(state.consecutiveStale).toBe(0);
  });

  it('CALIBRATION: a SLOW but live loop never escalates, however long it runs', () => {
    // The loop is heavily loaded — beating only every 9s, just inside the 10s
    // wedge line. This is the false-positive case that matters most in
    // production: a busy host must not be killed for being busy.
    const s = settledState();
    const slow = Array.from({ length: 200 }, (_, i) => ({
      counter: 1000 + i + 1,
      nowMs: 100_000 + (i + 1) * 9_000,
    }));
    const { actions } = run(s, slow);
    expect(actions.some((a) => a.kind === 'kill')).toBe(false);
    expect(actions.some((a) => a.kind === 'escalate-never-started')).toBe(false);
  });

  it('a single long pause that recovers does NOT accumulate toward a kill', () => {
    // Two wedge-length stalls separated by recovery. With observationsToAct=3,
    // neither run reaches the debounce, and the counter reset must clear the
    // first run's credit rather than carrying it into the second.
    const s = settledState();
    const seq: LoopSentinelObservation[] = [
      ...frozenAfter(s, 100_000, 2, 11_000), // 2 stale observations
      { counter: s.lastCounter + 1, nowMs: 130_000 }, // recovers
      // 2 more stale observations, frozen at the RECOVERED counter
      ...Array.from({ length: 2 }, (_, i) => ({
        counter: s.lastCounter + 1,
        nowMs: 130_000 + (i + 1) * 11_000,
      })),
    ];
    const { actions } = run(s, seq);
    expect(actions.some((a) => a.kind === 'kill')).toBe(false);
    expect(actions.filter((a) => a.kind === 'warn')).toHaveLength(4);
  });
});

describe('event-loop-sentinel worker starvation wiring', () => {
  it('reads CPU PSI in the worker and keeps unknown PSI on the normal kill path', () => {
    const source = readFileSync(resolve(__dirname, 'event-loop-sentinel.worker.ts'), 'utf8');
    expect(source).toContain("readFileSync('/proc/pressure/cpu', 'utf8')");
    expect(source).toContain('parseCpuPressureSomeAvg60');
    expect(source).toContain('isConfirmedCpuStarvation(activity)');
    expect(source).toContain('mainThreadCpuPsiSome60');
  });

  it('routes confirmed D-state directory I/O waits away from the SIGKILL path', () => {
    const source = readFileSync(resolve(__dirname, 'event-loop-sentinel.worker.ts'), 'utf8');
    const killBranch = source.slice(source.indexOf("case 'kill':"));
    expect(killBranch).toContain('if (isConfirmedHostIoWait(activity))');
    expect(killBranch).toContain('main event loop WEDGED — host I/O wait, NOT killing');
  });
});

describe('decideLoopSentinelAction — a wedged loop is caught', () => {
  it('CALIBRATION: a genuinely wedged loop DOES kill once the debounce is met', () => {
    // Without this, every safety property below is satisfied by a decider that
    // simply never kills. This is the case that makes the controls meaningful.
    const s = settledState();
    const { actions } = run(s, frozenAfter(s, 100_000, 3, 11_000));
    expect(actions.map((a) => a.kind)).toEqual(['warn', 'warn', 'kill']);
  });

  it('the kill reason names the staleness, the threshold and the debounce', () => {
    const s = settledState();
    const { actions } = run(s, frozenAfter(s, 100_000, 3, 11_000));
    const kill = actions.at(-1)!;
    expect(kill.kind).toBe('kill');
    if (kill.kind !== 'kill') throw new Error('unreachable');
    expect(kill.reason).toContain('10000ms');
    expect(kill.reason).toContain('3 consecutive');
    expect(kill.stalenessMs).toBeGreaterThanOrEqual(T.wedgeAfterMs);
  });

  it('replays the real incident: a 30-minute block kills', () => {
    // EI-19465075959589134 — :3170 blocked at 16:14:17Z and was still wedged
    // 30+ min later, recovered only by a manual restart.
    const s = settledState();
    const thirtyMin = frozenAfter(s, 100_000, 30 * 60, 1_000);
    const { actions } = run(s, thirtyMin);
    const firstKill = actions.findIndex((a) => a.kind === 'kill');
    expect(firstKill).toBeGreaterThanOrEqual(0);
    // Caught in ~12s, not 30 min.
    expect(firstKill).toBeLessThan(15);
  });

  it('warns before it kills, so a wedge is visible in logs first', () => {
    const s = settledState();
    const { actions } = run(s, frozenAfter(s, 100_000, 3, 11_000));
    expect(actions.filter((a) => a.kind === 'warn')).toHaveLength(2);
  });
});

describe('decideLoopSentinelAction — the two safety guards', () => {
  it('GUARD 1: never acts inside the startup grace window, however stale', () => {
    // A host whose loop is blocked from boot looks maximally wedged. Boot is
    // legitimately busy, so the grace window must dominate.
    const s0 = initialLoopSentinelState(0, 0);
    const { actions } = run(s0, frozenAfter(s0, 0, 20, 1_000)); // 20s < 30s grace
    expect(actions.every((a) => a.kind === 'grace')).toBe(true);
  });

  it('GUARD 2: an unarmed heartbeat ESCALATES, it never kills', () => {
    // The counter never moved even once. Indistinguishable from "the heartbeat
    // was never wired up" — killing here turns a bug in the sentinel into a
    // host boot loop. The out-of-process probe owns never-started.
    const s0 = initialLoopSentinelState(0, 0);
    const { actions } = run(s0, frozenAfter(s0, 0, 60, 1_000)); // past grace
    expect(actions.some((a) => a.kind === 'kill')).toBe(false);
    expect(actions.some((a) => a.kind === 'escalate-never-started')).toBe(true);
  });

  it('GUARD 2 lifts the instant a single heartbeat is observed', () => {
    // One beat proves the heartbeat is wired; a wedge after it is killable.
    const s0 = initialLoopSentinelState(0, 0);
    const afterGrace = run(s0, [{ counter: 1, nowMs: 40_000 }]).state;
    expect(afterGrace.sawHeartbeat).toBe(true);
    const { actions } = run(afterGrace, frozenAfter(afterGrace, 40_000, 3, 11_000));
    expect(actions.at(-1)!.kind).toBe('kill');
  });
});

describe('decideLoopSentinelAction — clock robustness', () => {
  it('a backward clock step cannot manufacture staleness', () => {
    // Staleness is clamped at 0, so a non-monotonic reading degrades to "ok"
    // rather than to a negative that compares oddly against thresholds.
    const s = settledState();
    const d = decideLoopSentinelAction(s, { counter: 1000, nowMs: 0 }, T);
    expect(d.action.kind).toBe('ok');
    expect(d.action.stalenessMs).toBe(0);
  });

  it('is a pure function of (state, observation, thresholds)', () => {
    const s = settledState();
    const obs = { counter: 1000, nowMs: 200_000 };
    const a = decideLoopSentinelAction(s, obs, T);
    const b = decideLoopSentinelAction(s, obs, T);
    expect(a).toEqual(b);
    expect(s.consecutiveStale).toBe(0); // input state not mutated
  });
});

/**
 * FALSIFIABILITY CONTROLS.
 *
 * Deliberately-wrong deciders kept permanently in the test file. Each violates
 * exactly ONE guard. The properties below must FAIL for the control and PASS
 * for the real decider — otherwise the property is vacuous and proves nothing.
 * Never mutate the production module to test this (see CLAUDE.md: a mutation
 * held in the shared tree can be committed by the git-sync sweep).
 */
describe('falsifiability controls — the guards are load-bearing', () => {
  /** Control A: ignores `sawHeartbeat` — would kill an unarmed heartbeat. */
  function decideIgnoringHeartbeatGuard(
    state: LoopSentinelState,
    obs: LoopSentinelObservation,
    t: LoopSentinelThresholds,
  ): LoopSentinelDecisionLike {
    const d = decideLoopSentinelAction({ ...state, sawHeartbeat: true }, obs, t);
    return { state: { ...d.state, sawHeartbeat: state.sawHeartbeat }, action: d.action };
  }

  /** Control B: ignores the startup grace window. */
  function decideIgnoringGrace(
    state: LoopSentinelState,
    obs: LoopSentinelObservation,
    t: LoopSentinelThresholds,
  ): LoopSentinelDecisionLike {
    return decideLoopSentinelAction(state, obs, { ...t, startupGraceMs: 0 });
  }

  type LoopSentinelDecisionLike = { state: LoopSentinelState; action: LoopSentinelAction };
  type Decider = (
    s: LoopSentinelState,
    o: LoopSentinelObservation,
    t: LoopSentinelThresholds,
  ) => LoopSentinelDecisionLike;

  function killsIn(decider: Decider, observations: LoopSentinelObservation[]): boolean {
    let s = initialLoopSentinelState(0, 0);
    for (const obs of observations) {
      const d = decider(s, obs, T);
      s = d.state;
      if (d.action.kind === 'kill') return true;
    }
    return false;
  }

  const neverStarted = frozenAfter(initialLoopSentinelState(0, 0), 0, 60, 1_000);
  const wedgedAtBoot = frozenAfter(initialLoopSentinelState(0, 0), 0, 20, 1_000);

  it('control A (no heartbeat guard) KILLS an unarmed heartbeat — the real one does not', () => {
    expect(killsIn(decideIgnoringHeartbeatGuard, neverStarted)).toBe(true);
    expect(killsIn(decideLoopSentinelAction, neverStarted)).toBe(false);
  });

  it('control B (no grace window) KILLS during boot — the real one does not', () => {
    // Control B still needs a heartbeat to reach the kill branch, so give it
    // one beat, then freeze — isolating the grace guard as the only difference.
    const bootWithOneBeat = [{ counter: 1, nowMs: 500 }, ...wedgedAtBoot.map((o) => ({ ...o, counter: 1, nowMs: o.nowMs + 500 }))];
    expect(killsIn(decideIgnoringGrace, bootWithOneBeat)).toBe(true);
    expect(killsIn(decideLoopSentinelAction, bootWithOneBeat)).toBe(false);
  });
});
