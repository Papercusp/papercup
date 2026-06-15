import { describe, it, expect } from 'vitest';
import { accountTokens, verifyIsoBudget, budgetExceeded, isScored } from './cost';
import type { TaskRunResult } from './schema';

function mk(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 't1',
    arm: 'papercusp',
    seed: 1,
    resolved: false,
    graderStatus: 'failed',
    graderFamily: 'swe-bench-pro',
    graderVersion: 'v1',
    tokensIn: 1000,
    tokensOut: 500,
    tokensTotal: 1500,
    costUsd: 0,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 1,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: 'ro1',
    createdAt: '2026-06-15T00:00:00Z',
    ...over,
  };
}

describe('budgetExceeded', () => {
  it('trips on tokens, on $, or never when uncapped', () => {
    expect(budgetExceeded({ tokensTotal: 999_999 }, { tokens: 1_000_000 })).toBe(false);
    expect(budgetExceeded({ tokensTotal: 1_000_000 }, { tokens: 1_000_000 })).toBe(true); // ≥
    expect(budgetExceeded({ tokensTotal: 10, costUsd: 5 }, { usd: 5 })).toBe(true);
    expect(budgetExceeded({ tokensTotal: 10, costUsd: 4.99 }, { usd: 5 })).toBe(false);
    expect(budgetExceeded({ tokensTotal: 9e9 }, { tokens: null, usd: null })).toBe(false); // uncapped
  });
});

describe('isScored', () => {
  it('is true only when neither generation nor grading hit an infra error', () => {
    expect(isScored(mk({ generationStatus: 'completed', graderStatus: 'failed' }))).toBe(true);
    expect(isScored(mk({ generationStatus: 'error' }))).toBe(false);
    expect(isScored(mk({ generationStatus: 'timeout' }))).toBe(false);
    expect(isScored(mk({ graderStatus: 'error' }))).toBe(false);
    expect(isScored(mk({ graderStatus: 'timeout' }))).toBe(false);
  });
});

describe('accountTokens', () => {
  it('sums tokens and derives cost from the price table (coordination overhead counted)', () => {
    const rows = [
      mk({ tokensIn: 1_000_000, tokensOut: 0, tokensTotal: 1_000_000, resolved: true, graderStatus: 'passed' }),
      mk({ tokensIn: 0, tokensOut: 1_000_000, tokensTotal: 1_000_000, resolved: false }),
    ];
    const acc = accountTokens(rows);
    expect(acc.tokensTotal).toBe(2_000_000);
    expect(acc.costUsd).toBeCloseTo(5 + 25, 10); // 1M Opus input + 1M Opus output
    expect(acc.tokensPerRun).toBe(1_000_000);
    expect(acc.costPerResolved).toBeCloseTo(30, 10); // 1 resolved
  });

  it('costPerResolved is null when nothing resolved', () => {
    expect(accountTokens([mk()]).costPerResolved).toBeNull();
  });
});

describe('verifyIsoBudget', () => {
  it('passes when every arm shares one cap and no row exceeds it', () => {
    const r = verifyIsoBudget([
      mk({ arm: 'papercusp', budgetTokens: 1_000_000, tokensTotal: 900_000 }),
      mk({ arm: 'baseline-b-native', budgetTokens: 1_000_000, tokensTotal: 950_000 }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.budgetTokens).toBe(1_000_000);
    expect(r.violations).toEqual([]);
  });

  it('flags a row over its cap that is not marked capped', () => {
    const bad = verifyIsoBudget([mk({ budgetTokens: 1_000_000, tokensTotal: 1_500_000, capped: false })]);
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toMatch(/cap not enforced/);
    const ok = verifyIsoBudget([mk({ budgetTokens: 1_000_000, tokensTotal: 1_500_000, capped: true })]);
    expect(ok.ok).toBe(true);
  });

  it('flags arms running under different budgets', () => {
    const r = verifyIsoBudget([
      mk({ arm: 'papercusp', budgetTokens: 1_000_000 }),
      mk({ arm: 'baseline-b-native', budgetTokens: 2_000_000 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /different budgets/.test(v))).toBe(true);
  });

  it('flags mixing capped and uncapped arms', () => {
    const r = verifyIsoBudget([
      mk({ arm: 'papercusp', budgetTokens: 1_000_000 }),
      mk({ arm: 'baseline-b-native', budgetTokens: null }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /uncapped while others/.test(v))).toBe(true);
  });
});
