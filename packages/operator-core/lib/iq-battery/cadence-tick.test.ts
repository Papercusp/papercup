/**
 * cadence-tick.test.ts — the monthly IQ-battery cadence gates
 * (self-improvement-consume-edges-2026-06-12 P-033 / B-12).
 *
 * The load-bearing assertions: NO owner budget ⇒ REFUSE with zero side effects
 * (the gym's unattended-spend precedent), an already-measured SHA ⇒ skip with
 * zero spend, and a failed battery NEVER throws (durable-step replay = double
 * spend).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CADENCE_DEFAULT_CASES_PER_VARIANT,
  CADENCE_DEFAULT_REPEATS,
  ownerBudgetUsd,
  runBenchmarkCadenceTick,
  type BenchmarkCadenceDeps,
} from './cadence-tick';

function makeDeps(over: Partial<BenchmarkCadenceDeps> = {}) {
  const deps = {
    currentCodeSha: vi.fn(() => 'abc1234'),
    generationExists: vi.fn(async () => false),
    runBattery: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  return deps;
}

describe('ownerBudgetUsd — the owner-set budget contract', () => {
  it('accepts a positive finite number', () => {
    expect(ownerBudgetUsd({ budgetUsd: 25 })).toBe(25);
    expect(ownerBudgetUsd({ budgetUsd: 0.5 })).toBe(0.5);
  });

  it('rejects everything else — null payload, missing, zero, negative, NaN, strings', () => {
    expect(ownerBudgetUsd(null)).toBeNull();
    expect(ownerBudgetUsd({})).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: 0 })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: -5 })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: Number.NaN })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: Number.POSITIVE_INFINITY })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: '25' })).toBeNull();
  });
});

describe('runBenchmarkCadenceTick — gates in order', () => {
  it('REFUSES without an owner-set budget: no SHA read, no PG read, no battery', async () => {
    const deps = makeDeps();
    const out = await runBenchmarkCadenceTick(deps, { installSlug: 'papercup', payload: null });
    expect(out.action).toBe('refused');
    expect(out.action === 'refused' && out.reason).toMatch(/budgetUsd/);
    expect(deps.generationExists).not.toHaveBeenCalled();
    expect(deps.runBattery).not.toHaveBeenCalled();
  });

  it('REFUSES an invalid budget the same way (0 / "25")', async () => {
    for (const budgetUsd of [0, '25'] as const) {
      const deps = makeDeps();
      const out = await runBenchmarkCadenceTick(deps, { installSlug: 'papercup', payload: { budgetUsd } });
      expect(out.action).toBe('refused');
      expect(deps.runBattery).not.toHaveBeenCalled();
    }
  });

  it('REFUSES when the code SHA is unknowable — a generation needs an identity', async () => {
    const deps = makeDeps({ currentCodeSha: vi.fn(() => 'unknown') });
    const out = await runBenchmarkCadenceTick(deps, { installSlug: 'papercup', payload: { budgetUsd: 25 } });
    expect(out.action).toBe('refused');
    expect(out.action === 'refused' && out.reason).toMatch(/SHA/);
    expect(deps.runBattery).not.toHaveBeenCalled();
  });

  it('SKIPS an already-measured generation (replay / unchanged-code guard) with zero spend', async () => {
    const deps = makeDeps({ generationExists: vi.fn(async () => true) });
    const out = await runBenchmarkCadenceTick(deps, { installSlug: 'papercup', payload: { budgetUsd: 25 } });
    expect(out).toMatchObject({ action: 'skipped', codeSha: 'abc1234' });
    expect(deps.runBattery).not.toHaveBeenCalled();
  });

  it('runs a new generation with the owner cap + committed defaults', async () => {
    const deps = makeDeps();
    const out = await runBenchmarkCadenceTick(deps, { installSlug: 'gymloopharness', payload: { budgetUsd: 30 } });
    expect(out).toMatchObject({ action: 'ran', codeSha: 'abc1234', capUsd: 30 });
    expect(deps.runBattery).toHaveBeenCalledExactlyOnceWith({
      harness: 'gymloopharness',
      capUsd: 30,
      casesPerVariant: CADENCE_DEFAULT_CASES_PER_VARIANT,
      repeats: CADENCE_DEFAULT_REPEATS,
      dryRun: false,
    });
  });

  it('honors payload tunables, clamped to sane integers; dryRun must be literal true', async () => {
    const deps = makeDeps();
    await runBenchmarkCadenceTick(deps, {
      installSlug: 'papercup',
      payload: { budgetUsd: 10, casesPerVariant: 2.9, repeats: 0, dryRun: true },
    });
    expect(deps.runBattery).toHaveBeenCalledExactlyOnceWith({
      harness: 'papercup',
      capUsd: 10,
      casesPerVariant: 2, // floored
      repeats: 1, // clamped up — 0 repeats is not a run
      dryRun: true,
    });

    const deps2 = makeDeps();
    await runBenchmarkCadenceTick(deps2, {
      installSlug: 'papercup',
      payload: { budgetUsd: 10, casesPerVariant: 'lots', dryRun: 'yes' },
    });
    expect(deps2.runBattery).toHaveBeenCalledExactlyOnceWith({
      harness: 'papercup',
      capUsd: 10,
      casesPerVariant: CADENCE_DEFAULT_CASES_PER_VARIANT,
      repeats: CADENCE_DEFAULT_REPEATS,
      dryRun: false,
    });
  });

  it('a failed battery returns "failed" and NEVER throws (a thrown durable step = paid replay)', async () => {
    const deps = makeDeps({ runBattery: vi.fn(async () => { throw new Error('spend cap $10 would be exceeded'); }) });
    const out = await runBenchmarkCadenceTick(deps, { installSlug: 'papercup', payload: { budgetUsd: 10 } });
    expect(out).toMatchObject({ action: 'failed', codeSha: 'abc1234' });
    expect(out.action === 'failed' && out.error).toMatch(/spend cap/);
  });
});
