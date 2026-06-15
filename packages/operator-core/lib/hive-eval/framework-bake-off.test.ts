import { describe, it, expect, vi } from 'vitest';
import {
  summarizeArm,
  computeBakeoffDelta,
  runFrameworkBakeOff,
  type ArmScore,
  type BakeoffDeps,
} from './framework-bake-off';

const s = (scenarioId: string, composite: number, gatePassed = true): ArmScore => ({ scenarioId, composite, gatePassed });

describe('summarizeArm', () => {
  it('computes mean composite + gate-pass rate', () => {
    const arm = summarizeArm('baseline', false, [s('a', 0.8), s('b', 0.6, false), s('c', 0.7)]);
    expect(arm.meanComposite).toBeCloseTo(0.7, 5);
    expect(arm.gatePassRate).toBeCloseTo(2 / 3, 5);
  });

  it('is zero for an empty arm', () => {
    const arm = summarizeArm('treatment', true, []);
    expect(arm.meanComposite).toBe(0);
    expect(arm.gatePassRate).toBe(0);
  });
});

describe('computeBakeoffDelta', () => {
  const base = summarizeArm('baseline', false, [s('a', 0.6), s('b', 0.6)]);

  it('calls a real improvement "improved"', () => {
    const treat = summarizeArm('treatment', true, [s('a', 0.7), s('b', 0.7)]);
    expect(computeBakeoffDelta(base, treat).verdict).toBe('improved');
  });

  it('calls a small change "neutral"', () => {
    const treat = summarizeArm('treatment', true, [s('a', 0.61), s('b', 0.6)]);
    expect(computeBakeoffDelta(base, treat).verdict).toBe('neutral');
  });

  it('calls a composite drop "regressed"', () => {
    const treat = summarizeArm('treatment', true, [s('a', 0.5), s('b', 0.5)]);
    expect(computeBakeoffDelta(base, treat).verdict).toBe('regressed');
  });

  it('un-gameable floor: a gate-pass DROP is a regression even if composite rises', () => {
    const treat = summarizeArm('treatment', true, [s('a', 0.95, true), s('b', 0.95, false)]); // higher composite, worse gate
    const d = computeBakeoffDelta(base, treat);
    expect(d.deltaMeanComposite).toBeGreaterThan(0);
    expect(d.deltaGatePassRate).toBeLessThan(0);
    expect(d.verdict).toBe('regressed');
  });

  it('is inconclusive when either arm is empty', () => {
    expect(computeBakeoffDelta(base, summarizeArm('treatment', true, [])).verdict).toBe('inconclusive');
  });
});

describe('runFrameworkBakeOff', () => {
  it('runs flag OFF then ON over the same corpus, diffs, and restores the flag', async () => {
    const setCalls: Array<[string, boolean]> = [];
    let flagState = true; // pretend it was on originally
    const deps: BakeoffDeps = {
      getFlag: vi.fn(async () => flagState),
      setFlag: vi.fn(async (k: string, v: boolean) => {
        setCalls.push([k, v]);
        flagState = v;
      }),
      // OFF arm scores 0.6, ON arm scores 0.8 — call order distinguishes them.
      runBattery: vi
        .fn()
        .mockResolvedValueOnce([s('a', 0.6), s('b', 0.6)])
        .mockResolvedValueOnce([s('a', 0.8), s('b', 0.8)]),
    };

    const res = await runFrameworkBakeOff({ flagKey: 'papercusp-touch-set-exclusion' }, deps);

    expect(res.baseline.flagOn).toBe(false);
    expect(res.treatment.flagOn).toBe(true);
    expect(res.delta.verdict).toBe('improved');
    expect(deps.runBattery).toHaveBeenCalledTimes(2);
    // toggled OFF, then ON, then RESTORED to the original (true).
    expect(setCalls).toEqual([
      ['papercusp-touch-set-exclusion', false],
      ['papercusp-touch-set-exclusion', true],
      ['papercusp-touch-set-exclusion', true],
    ]);
    expect(flagState).toBe(true); // restored
  });

  it('restores the flag even when a battery run throws', async () => {
    let flagState = false;
    const deps: BakeoffDeps = {
      getFlag: vi.fn(async () => flagState),
      setFlag: vi.fn(async (_k: string, v: boolean) => {
        flagState = v;
      }),
      runBattery: vi.fn(async () => {
        throw new Error('battery boom');
      }),
    };
    await expect(runFrameworkBakeOff({ flagKey: 'papercusp-compiled-briefs' }, deps)).rejects.toThrow('battery boom');
    expect(flagState).toBe(false); // restored to original despite the throw
  });
});
