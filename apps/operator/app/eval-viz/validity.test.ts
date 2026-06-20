import { describe, expect, it } from 'vitest';
import { computeValiditySignals, isRunValid, validityCaveats, type ValidityInput } from './validity';

function sig(input: ValidityInput) {
  const signals = computeValiditySignals(input);
  const by = Object.fromEntries(signals.map((s) => [s.key, s]));
  return { signals, by };
}

describe('computeValiditySignals', () => {
  it('a completed run with no live fleet: opus/queen unknown, empty-diff/subset/seed honest caveats', () => {
    // m3-like: 11 tasks, 8 non-empty diffs, cap 5, single seed, fleet gone.
    const { by } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, seedCount: 1, live: null });
    expect(by['opus-only'].status).toBe('unknown');
    expect(by['queen-survival'].status).toBe('unknown');
    expect(by['empty-diff'].status).toBe('warn'); // 3 empty
    expect(by['empty-diff'].detail).toMatch(/3\/11/);
    expect(by['fleet-cap'].status).toBe('pass');
    expect(by['subset-size'].status).toBe('warn'); // 11 < 100
    expect(by['single-seed'].status).toBe('warn');
  });

  it('an unknown/warn-only run is still presentable as valid (no fail)', () => {
    const { signals } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, seedCount: 1, live: null });
    expect(isRunValid(signals)).toBe(true);
  });

  it('a live opus leak FAILS opus-only → not valid', () => {
    const { by, signals } = sig({
      taskCount: 11, nonEmptyDiffs: 11, capValue: 5,
      live: { queenAlive: true, queenAgeSec: 600, queenReclaims: 0, nonOpusSamples: 2, totalSamples: 50 },
    });
    expect(by['opus-only'].status).toBe('fail');
    expect(by['opus-only'].detail).toMatch(/2 non-opus/);
    expect(isRunValid(signals)).toBe(false);
  });

  it('a queen reclaim FAILS queen-survival → not valid', () => {
    const { by, signals } = sig({
      taskCount: 11, nonEmptyDiffs: 11, capValue: 5,
      live: { queenAlive: true, queenAgeSec: 600, queenReclaims: 1, nonOpusSamples: 0, totalSamples: 50 },
    });
    expect(by['queen-survival'].status).toBe('fail');
    expect(isRunValid(signals)).toBe(false);
  });

  it('a healthy live fleet passes opus-only + queen-survival', () => {
    const { by } = sig({
      taskCount: 11, nonEmptyDiffs: 11, capValue: 5,
      live: { queenAlive: true, queenAgeSec: 600, queenReclaims: 0, nonOpusSamples: 0, totalSamples: 50 },
    });
    expect(by['opus-only'].status).toBe('pass');
    expect(by['queen-survival'].status).toBe('pass');
  });

  it('a young queen (<300s) warns but does not fail', () => {
    const { by, signals } = sig({
      taskCount: 11, nonEmptyDiffs: 11, capValue: 5,
      live: { queenAlive: true, queenAgeSec: 120, queenReclaims: 0, nonOpusSamples: 0, totalSamples: 10 },
    });
    expect(by['queen-survival'].status).toBe('warn');
    expect(isRunValid(signals)).toBe(true);
  });

  it('a 0-work arm (all diffs empty) FAILS empty-diff — the 0-work-control refusal (D-003)', () => {
    const { by, signals } = sig({ taskCount: 11, nonEmptyDiffs: 0, capValue: 5, live: null });
    expect(by['empty-diff'].status).toBe('fail');
    expect(by['empty-diff'].detail).toMatch(/no model work/);
    expect(isRunValid(signals)).toBe(false);
  });

  it('a phantom win (resolved task with zero recorded generation) FAILS generation-attributed → not valid', () => {
    // m3-like: protonmail + qutebrowser graded RESOLVED on non-empty diffs but turns=0/cost=0/0 tokens.
    const { by, signals } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, recovered: true, resolvedZeroGen: 2, live: null });
    expect(by['generation-attributed'].status).toBe('fail');
    expect(by['generation-attributed'].detail).toMatch(/2 resolved task\(s\) have zero recorded generation/);
    expect(isRunValid(signals)).toBe(false);
  });

  it('all resolved tasks attributed (resolvedZeroGen 0) PASSES generation-attributed', () => {
    const { by } = sig({ taskCount: 11, nonEmptyDiffs: 11, capValue: 5, recovered: true, resolvedZeroGen: 0, live: null });
    expect(by['generation-attributed'].status).toBe('pass');
  });

  it('a recovered run with no per-task breakdown WARNS generation-attributed (phantom-win risk) but stays valid', () => {
    const { by, signals } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, recovered: true, live: null });
    expect(by['generation-attributed'].status).toBe('warn');
    expect(isRunValid(signals)).toBe(true);
  });

  it('a non-recovered run with no breakdown leaves generation-attributed unknown (not a caveat)', () => {
    const { by } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, live: null });
    expect(by['generation-attributed'].status).toBe('unknown');
  });

  it('an uncapped run warns on fleet-cap', () => {
    const { by } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: null, live: null });
    expect(by['fleet-cap'].status).toBe('warn');
  });

  it('validityCaveats returns only the warn/fail signals', () => {
    const { signals } = sig({ taskCount: 11, nonEmptyDiffs: 8, capValue: 5, seedCount: 1, live: null });
    const caveats = validityCaveats(signals);
    expect(caveats.every((c) => c.status === 'warn' || c.status === 'fail')).toBe(true);
    expect(caveats.map((c) => c.key).sort()).toEqual(['empty-diff', 'single-seed', 'subset-size']);
  });
});
