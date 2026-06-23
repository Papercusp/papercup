/**
 * tick-load-shed.test.ts — pins the shared background-tick load-shed policy
 * (operator-scalability-event-loop-2026-06-16 P5-1/P5-3). The sibling
 * in-process-periodic.test.ts only asserts WHICH ticks are classified heavy; the
 * actual shed DECISION logic here was untested. What this guards:
 *
 *  - shedUnderLoopPressure: sheds iff the event loop is critically saturated (P5-1),
 *    and emits the warn that makes the skip observable.
 *  - shedUnderPowerSave: the DETERMINISTIC per-tick cadence throttle (P5-3) — no
 *    Math.random; AC (multiplier 1) NEVER sheds; on battery it fires on exactly
 *    every multiplier-th invocation and skips the rest; counters are per-tickName.
 *  - shouldShedHeavyTick: OR of the two, and (critically) the `||` SHORT-CIRCUIT —
 *    a loop-pressure shed must NOT advance the power-save counter, or the cadence
 *    desyncs under sustained load.
 *
 * Pure: the only two I/O reads (isLoopSaturated, getResourceProfile) are mocked via
 * a vi.hoisted control object; each test uses a UNIQUE tickName so the module-global
 * power-save counter Map can't bleed across cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ saturated: false, cadenceMult: 1 }));

vi.mock('../event-loop-lag-monitor', () => ({
  isLoopSaturated: () => ctl.saturated,
}));
vi.mock('../resource-profile', () => ({
  getResourceProfile: () => ({ backgroundCadenceMultiplier: ctl.cadenceMult }),
}));

import { shedUnderLoopPressure, shedUnderPowerSave, shouldShedHeavyTick } from './tick-load-shed';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ctl.saturated = false;
  ctl.cadenceMult = 1;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shedUnderLoopPressure (P5-1)', () => {
  it('sheds and warns when the event loop is critically saturated', () => {
    ctl.saturated = true;
    expect(shedUnderLoopPressure('lps-saturated')).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('lps-saturated');
  });

  it('does not shed (and does not warn) when the loop is healthy', () => {
    ctl.saturated = false;
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
  it('sheds when only loop pressure is present', () => {
    ctl.saturated = true;
    ctl.cadenceMult = 1; // power-save would not shed
    expect(shouldShedHeavyTick('heavy-lp-only')).toBe(true);
  });

  it('sheds when only power-save is present (AC loop healthy)', () => {
    ctl.saturated = false;
    ctl.cadenceMult = 3;
    expect(shouldShedHeavyTick('heavy-ps-only')).toBe(true); // first invocation skips at mult 3
  });

  it('does not shed when neither condition holds', () => {
    ctl.saturated = false;
    ctl.cadenceMult = 1;
    expect(shouldShedHeavyTick('heavy-none')).toBe(false);
  });

  it('SHORT-CIRCUITS: a loop-pressure shed does NOT advance the power-save counter', () => {
    ctl.cadenceMult = 3;
    // While saturated, shouldShedHeavyTick returns true via P5-1 and must NOT
    // consult/advance the power-save counter for this tick.
    ctl.saturated = true;
    expect(shouldShedHeavyTick('heavy-shortcircuit')).toBe(true);
    expect(shouldShedHeavyTick('heavy-shortcircuit')).toBe(true);
    // Loop recovers. The power-save counter must still be at 0, so the NEXT power-save
    // call is the FIRST real invocation (n=1 -> skip at mult 3). If the short-circuit
    // were broken and the counter had advanced to 2, this would instead be n=3 -> fire.
    ctl.saturated = false;
    expect(shedUnderPowerSave('heavy-shortcircuit')).toBe(true);
  });
});
