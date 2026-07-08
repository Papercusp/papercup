/**
 * tick-load-shed.test.ts — pins the shared background-tick load-shed policy
 * (operator-scalability-event-loop-2026-06-16 P5-1/P5-3). The sibling
 * in-process-periodic.test.ts only asserts WHICH ticks are classified heavy; the
 * actual shed DECISION logic here was untested. What this guards:
 *
 *  - shedUnderLoopPressure: CRITICAL (p95≥600ms) ⇒ FULL shed every cycle; ELEVATED
 *    (p95≥120ms) ⇒ WIDENED cadence, shed 1 of every N cycles
 *    (PAPERCUSP_LOOP_ELEVATED_SHED_EVERY, default 2; ≤1 disables the widening). The
 *    600ms-only trip meant 0 sheds in 2h despite 115 high-lag windows (WI-1084), but
 *    a FULL elevated shed would starve the heavy tick across the sustained 130–240ms
 *    band — so the elevated band sheds a deterministic fraction. Never sheds when 'ok'.
 *    Emits a distinct [loop-shed] warn naming the band so the skip is observable.
 *  - shedUnderPowerSave: the DETERMINISTIC per-tick cadence throttle (P5-3) — no
 *    Math.random; AC (multiplier 1) NEVER sheds; on battery it fires on exactly
 *    every multiplier-th invocation and skips the rest; counters are per-tickName.
 *  - shouldShedHeavyTick: OR of the two, and (critically) the `||` SHORT-CIRCUIT —
 *    a loop-pressure shed must NOT advance the power-save counter, or the cadence
 *    desyncs under sustained load.
 *
 * Pure: the only two I/O reads (loopPressure, getResourceProfile) are mocked via
 * a vi.hoisted control object; each test uses a UNIQUE tickName so the module-global
 * power-save counter Map can't bleed across cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopPressure } from '../event-loop-lag-monitor';

const ctl = vi.hoisted(() => ({ pressure: 'ok' as LoopPressure, cadenceMult: 1 }));

vi.mock('../event-loop-lag-monitor', () => ({
  loopPressure: () => ctl.pressure,
}));
vi.mock('../resource-profile', () => ({
  getResourceProfile: () => ({ backgroundCadenceMultiplier: ctl.cadenceMult }),
}));

import {
  shedUnderLoopPressure,
  shedUnderPowerSave,
  shouldShedHeavyTick,
  shouldShedSchedulerTickUnderLoopPressure,
} from './tick-load-shed';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ctl.pressure = 'ok';
  ctl.cadenceMult = 1;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('shedUnderLoopPressure (P5-1)', () => {
  it('sheds a FRACTION of cycles under ELEVATED — default shed 1 of every 2 (the chronic 130–240ms band)', () => {
    ctl.pressure = 'elevated';
    // Default PAPERCUSP_LOOP_ELEVATED_SHED_EVERY=2: n=1 run, n=2 shed, n=3 run, n=4 shed.
    const shed = Array.from({ length: 4 }, () => shedUnderLoopPressure('lps-elevated'));
    expect(shed).toEqual([false, true, false, true]);
    // Warns once per actual shed; the first warn fires on the 2nd (shedding) call.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const msg: string = warnSpy.mock.calls[0]![0];
    expect(msg).toContain('[loop-shed]');
    expect(msg).toContain('lps-elevated');
    expect(msg.toLowerCase()).toContain('elevated');
  });

  it('honors PAPERCUSP_LOOP_ELEVATED_SHED_EVERY (shed 1 of every 3 under ELEVATED)', () => {
    ctl.pressure = 'elevated';
    vi.stubEnv('PAPERCUSP_LOOP_ELEVATED_SHED_EVERY', '3');
    const shed = Array.from({ length: 6 }, () => shedUnderLoopPressure('lps-every3'));
    expect(shed).toEqual([false, false, true, false, false, true]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('a SHED_EVERY ≤ 1 DISABLES the elevated widening (heavy ticks then shed only at CRITICAL)', () => {
    ctl.pressure = 'elevated';
    vi.stubEnv('PAPERCUSP_LOOP_ELEVATED_SHED_EVERY', '1');
    const shed = Array.from({ length: 4 }, () => shedUnderLoopPressure('lps-disabled'));
    expect(shed).toEqual([false, false, false, false]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sheds EVERY cycle (FULL shed) and warns when the event loop is CRITICAL (the acute saturation band)', () => {
    ctl.pressure = 'critical';
    const shed = Array.from({ length: 3 }, () => shedUnderLoopPressure('lps-critical'));
    expect(shed).toEqual([true, true, true]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const msg: string = warnSpy.mock.calls[0]![0];
    expect(msg).toContain('[loop-shed]');
    expect(msg).toContain('lps-critical');
    expect(msg.toLowerCase()).toContain('critical');
  });

  it('does not shed (and does not warn) when the loop is healthy (ok)', () => {
    ctl.pressure = 'ok';
    expect(shedUnderLoopPressure('lps-healthy')).toBe(false);
    expect(shedUnderLoopPressure('lps-healthy')).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('shedUnderPowerSave (P5-3)', () => {
  it('on AC (multiplier 1) NEVER sheds, no matter how many invocations', () => {
    ctl.cadenceMult = 1;
    for (let i = 0; i < 10; i++) {
      expect(shedUnderPowerSave('ps-ac')).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a multiplier <= 1 (defensive: 0) also never sheds', () => {
    ctl.cadenceMult = 0;
    expect(shedUnderPowerSave('ps-zero')).toBe(false);
    expect(shedUnderPowerSave('ps-zero')).toBe(false);
  });

  it('at multiplier 3, fires on every 3rd invocation and skips the other 2', () => {
    ctl.cadenceMult = 3;
    // n=1 -> 1%3 skip, n=2 -> 2%3 skip, n=3 -> 0 fire, repeat.
    const shed = Array.from({ length: 6 }, () => shedUnderPowerSave('ps-mult3'));
    expect(shed).toEqual([true, true, false, true, true, false]);
    // skipped 4 of 6 -> warned 4 times.
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it('at multiplier 2, fires on every other invocation', () => {
    ctl.cadenceMult = 2;
    const shed = Array.from({ length: 4 }, () => shedUnderPowerSave('ps-mult2'));
    expect(shed).toEqual([true, false, true, false]);
  });

  it('keeps an INDEPENDENT counter per tickName (no cross-tick interference)', () => {
    ctl.cadenceMult = 2;
    // Interleave two ticks; each must advance only its own counter.
    expect(shedUnderPowerSave('ps-a')).toBe(true); // a:1 -> skip
    expect(shedUnderPowerSave('ps-b')).toBe(true); // b:1 -> skip
    expect(shedUnderPowerSave('ps-a')).toBe(false); // a:2 -> fire
    expect(shedUnderPowerSave('ps-b')).toBe(false); // b:2 -> fire
  });
});

describe('shouldShedHeavyTick (P5-1 || P5-3)', () => {
  it('sheds on the WIDENED cadence when loop is ELEVATED (the primary fix — chronic 130–240ms regime)', () => {
    ctl.pressure = 'elevated';
    ctl.cadenceMult = 1; // power-save would not shed; only the elevated widening fires
    // Default shed 1 of every 2 ⇒ run, shed, run, shed.
    const shed = Array.from({ length: 4 }, () => shouldShedHeavyTick('heavy-elevated-only'));
    expect(shed).toEqual([false, true, false, true]);
  });

  it('sheds EVERY cycle when loop is CRITICAL', () => {
    ctl.pressure = 'critical';
    ctl.cadenceMult = 1;
    const shed = Array.from({ length: 3 }, () => shouldShedHeavyTick('heavy-critical-only'));
    expect(shed).toEqual([true, true, true]);
  });

  it('sheds when only power-save is present (ok loop)', () => {
    ctl.pressure = 'ok';
    ctl.cadenceMult = 3;
    expect(shouldShedHeavyTick('heavy-ps-only')).toBe(true); // first invocation skips at mult 3
  });

  it('does not shed when neither condition holds', () => {
    ctl.pressure = 'ok';
    ctl.cadenceMult = 1;
    expect(shouldShedHeavyTick('heavy-none')).toBe(false);
  });

  it('SHORT-CIRCUITS: a loop-pressure shed does NOT advance the power-save counter', () => {
    ctl.cadenceMult = 3;
    // While CRITICAL, shouldShedHeavyTick returns true via P5-1 every cycle and must
    // NOT consult/advance the power-save counter for this tick. (CRITICAL is used here
    // rather than ELEVATED because the full-shed band sheds on every call, isolating
    // the short-circuit from the elevated band's own fractional cadence.)
    ctl.pressure = 'critical';
    expect(shouldShedHeavyTick('heavy-shortcircuit')).toBe(true);
    expect(shouldShedHeavyTick('heavy-shortcircuit')).toBe(true);
    // Loop recovers. The power-save counter must still be at 0, so the NEXT power-save
    // call is the FIRST real invocation (n=1 -> skip at mult 3). If the short-circuit
    // were broken and the counter had advanced to 2, this would instead be n=3 -> fire.
    ctl.pressure = 'ok';
    expect(shedUnderPowerSave('heavy-shortcircuit')).toBe(true);
  });
});

describe('shouldShedSchedulerTickUnderLoopPressure (WI-3351)', () => {
  it('does not shed the root routinesTick scheduler under ELEVATED loop pressure', () => {
    ctl.pressure = 'elevated';
    expect(shouldShedSchedulerTickUnderLoopPressure()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not shed the root routinesTick scheduler under CRITICAL loop pressure', () => {
    ctl.pressure = 'critical';
    expect(shouldShedSchedulerTickUnderLoopPressure()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
