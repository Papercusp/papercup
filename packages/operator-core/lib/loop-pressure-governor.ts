/**
 * loop-pressure-governor.ts — P5-2 (operator-scalability-event-loop-2026-06-16).
 *
 * Closed-loop concurrency feedback. The fleet's effective agent concurrency
 * already self-throttles on provider 429s via the AIMD governor (rate-limit-layer
 * D-005). But a 429 is a REMOTE signal — it says nothing about whether THIS box's
 * single event loop is melting under the work it already admitted. That local
 * saturation is exactly what crash-looped :3070 (p99 loop delay ~103s; see the
 * operator-crash-loop insight): the loop was wedged while the fleet kept admitting
 * more agents into it.
 *
 * P5-1 added the signal — {@link loopPressure} (a band off the event-loop-lag
 * histogram). This governor closes the loop on it: a light timer reads
 * loopPressure() and, on a transition INTO `critical` saturation, applies ONE AIMD
 * multiplicative-decrease (halve effective concurrency toward the floor) so the
 * fleet sheds the load the box can't carry; on recovery to `ok` it records a clean
 * step and the existing AIMD ramp (+1 per N) walks concurrency back up. Debounced
 * by transition so a sustained-critical loop is penalized once per episode, not
 * once per tick.
 *
 * Bounded + self-recovering by construction: it only narrows effective concurrency
 * UNDER the user's `maxSimultaneousAgents` cap, never below the floor, and ramps
 * back automatically — so a false `critical` (a one-off long GC) costs at most a
 * temporary, self-correcting dip. Inactive while no finite cap is installed (AIMD
 * off). Always-on infra like the lag monitor + the P5-1 load-shedding it pairs with.
 */
import { loopPressure, type LoopPressure } from './event-loop-lag-monitor';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
} from '@papercusp/papercusp-shared/agent';

export interface LoopPressureGovernorOpts {
  /** Evaluation cadence (ms). Default 15_000 — fast enough to react within seconds
   *  of sustained saturation, slow enough to be free. */
  intervalMs?: number;
  /** Pressure source. Defaults to the live {@link loopPressure}; injected in tests. */
  readPressure?: () => LoopPressure;
  /** AIMD multiplicative-decrease. Defaults to the global governor seam; injected in tests. */
  onPenalty?: () => void;
  /** AIMD clean-step. Defaults to the global governor seam; injected in tests. */
  onClean?: () => void;
  /** Structured log sink. Default console.warn. */
  log?: (line: string) => void;
}

export interface LoopPressureGovernorHandle {
  /** Stop the timer (unref'd already, so it never holds the process open). */
  stop(): void;
  /** Run one evaluation step now — drives the timer; exported for tests. */
  tick(): void;
}

// One per process. A second start() returns the existing handle (idempotent boot).
let active: LoopPressureGovernorHandle | undefined;

export function startLoopPressureGovernor(opts: LoopPressureGovernorOpts = {}): LoopPressureGovernorHandle {
  if (active) return active;
  const intervalMs = opts.intervalMs ?? 15_000;
  const readPressure = opts.readPressure ?? loopPressure;
  const onPenalty = opts.onPenalty ?? recordGlobalConcurrencyPenalty;
  const onClean = opts.onClean ?? recordGlobalConcurrencyClean;
  const log = opts.log ?? ((m) => console.warn(m));
  let last: LoopPressure = 'ok';

  const tick = (): void => {
    const p = readPressure();
    if (p === 'critical' && last !== 'critical') {
      // Transition INTO critical → shed once. Debounced: a loop that STAYS critical
      // isn't halved every tick (that would crater eff to the floor in a few ticks).
      onPenalty();
      log('[loop-governor] event loop critically saturated — shedding effective agent concurrency (P5-2)');
    } else if (p === 'ok' && last !== 'ok') {
      // Fully recovered → start ramping eff back (the AIMD +1-per-N walk continues it).
      onClean();
      log('[loop-governor] event loop recovered — ramping effective agent concurrency back up (P5-2)');
    }
    last = p;
  };

  const timer = managedSetInterval('loop-pressure-governor', intervalMs, tick, { category: 'watchdog' });

  const handle: LoopPressureGovernorHandle = {
    stop() {
      timer.stop();
      if (active === handle) active = undefined;
    },
    tick,
  };
  active = handle;
  return handle;
}

/** Stop the running governor (test/lifecycle hook). */
export function stopLoopPressureGovernor(): void {
  active?.stop();
}
