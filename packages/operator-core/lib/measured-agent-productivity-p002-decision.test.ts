import { beforeAll, describe, expect, it } from 'vitest';
import * as real from './measured-agent-productivity-p002-decision';
import type { P002Cell, P002ComparisonInput } from './measured-agent-productivity-p002-decision';

// The mutation probe (scripts/mutation-probe.sh, copy-out mode) points this at a
// mutated copy so the tracked module is never dirtied.
let evaluate: typeof real.evaluateP002Comparison = real.evaluateP002Comparison;
beforeAll(async () => {
  const override = process.env.P002_DECISION_MODULE;
  if (override) evaluate = ((await import(override)) as typeof real).evaluateP002Comparison;
});

const RUBRIC = 'rubric-hash-a';
const TASKS = ['T-1', 'T-2', 'T-3'];

function cells(variantId: string, composites: number[], extra: Partial<P002Cell> = {}): P002Cell[] {
  return TASKS.map((taskId, index) => ({
    taskId,
    variantId,
    status: 'scored',
    composite: composites[index],
    rubricHash: RUBRIC,
    ...extra,
  }));
}

function input(overrides: Partial<P002ComparisonInput> = {}): P002ComparisonInput {
  return {
    method: { baselineVariant: 'baseline', minDelta: 0, preselectedWinner: null, rubricHash: RUBRIC },
    variants: [
      { id: 'baseline', removes: [] },
      { id: 'dedup', removes: ['duplicate', 'older-history'] },
    ],
    unavailableArms: [],
    cells: [...cells('baseline', [6, 6, 6]), ...cells('dedup', [7, 7, 7])],
    ...overrides,
  };
}

describe('P-002 R-002: preserve useful, relevant preload', () => {
  it('never adopts a strategy that drops task-linked preload, even when it scores higher', () => {
    const result = evaluate(input({
      variants: [
        { id: 'baseline', removes: [] },
        { id: 'aggressive-trim', removes: ['task-linked', 'duplicate'] },
      ],
      cells: [...cells('baseline', [6, 6, 6]), ...cells('aggressive-trim', [9, 9, 9])],
    }));
    expect(result.compared).toEqual([
      expect.objectContaining({ variantId: 'aggressive-trim', eligible: false, ineligibleReason: 'drops-protected-preload:task-linked' }),
    ]);
    expect(result.verdict).toBe('baseline-holds');
    expect(result.winner).toBe('baseline');
    expect(result.preload).toBe('retain-current-preload');
  });

  it('removes duplicate material only when matched quality evidence shows it was unnecessary', () => {
    const adopted = evaluate(input());
    expect(adopted.verdict).toBe('adopt');
    expect(adopted.winner).toBe('dedup');
    expect(adopted.preload).toBe('apply-overlay');
    expect(adopted.removalEvidence).toEqual({ 'T-1': 1, 'T-2': 1, 'T-3': 1 });

    const regressed = evaluate(input({ cells: [...cells('baseline', [6, 6, 6]), ...cells('dedup', [7, 5, 4])] }));
    expect(regressed.verdict).toBe('baseline-holds');
    expect(regressed.preload).toBe('retain-current-preload');
    expect(regressed.removalEvidence).toBeNull();
  });
});

describe('P-002 R-001: verified productivity, not raw efficiency', () => {
  it('does not adopt a faster, leaner strategy whose judged quality fell', () => {
    const result = evaluate(input({
      cells: [
        ...cells('baseline', [8, 8, 8], { elapsedMs: 30000, tokens: 200000, toolCalls: 40 }),
        ...cells('dedup', [7.5, 7.5, 7.5], { elapsedMs: 10000, tokens: 90000, toolCalls: 12 }),
      ],
    }));
    expect(result.verdict).toBe('baseline-holds');
    expect(result.compared[0].delta).toBeCloseTo(-0.5, 10);
  });

  it('refuses to declare any outcome when a cell is unscored', () => {
    const partial = [...cells('baseline', [6, 6, 6]), ...cells('dedup', [9, 9, 9])];
    partial[4] = { ...partial[4], status: 'errored', composite: null };
    const result = evaluate(input({ cells: partial }));
    expect(result.verdict).toBe('unfair-comparison');
    expect(result.fairnessViolations).toContain('unscored-cell:dedup:T-2');
    expect(result.winner).toBeNull();
  });
});

describe('P-002 R-004: fair comparison with no preselected winner', () => {
  it('rejects an arm evaluated on a different task set', () => {
    const shifted = cells('dedup', [9, 9, 9]).map((cell, i) => (i === 2 ? { ...cell, taskId: 'T-9' } : cell));
    const result = evaluate(input({ cells: [...cells('baseline', [6, 6, 6]), ...shifted] }));
    expect(result.verdict).toBe('unfair-comparison');
    expect(result.fairnessViolations).toContain('unmatched-task-set:dedup');
  });

  it('rejects a preselected winner and a mixed rubric', () => {
    const preselected = evaluate(input({
      method: { baselineVariant: 'baseline', minDelta: 0, preselectedWinner: 'dedup', rubricHash: RUBRIC },
    }));
    expect(preselected.fairnessViolations).toEqual(['preselected-winner:dedup']);

    const mixed = [...cells('baseline', [6, 6, 6]), ...cells('dedup', [7, 7, 7])];
    mixed[3] = { ...mixed[3], rubricHash: 'rubric-hash-b' };
    expect(evaluate(input({ cells: mixed })).fairnessViolations).toEqual(['rubric-mismatch:dedup:T-1']);
  });

  it('reports an arm that could not run with its reason, and requires one', () => {
    const disclosed = evaluate(input({ unavailableArms: [{ id: 'higher-context', reason: 'runtime cap' }] }));
    expect(disclosed.fair).toBe(true);
    expect(disclosed.notCompared).toEqual([{ id: 'higher-context', reason: 'runtime cap' }]);
    expect(disclosed.compared.map((arm) => arm.variantId)).toEqual(['dedup']);

    const silent = evaluate(input({ unavailableArms: [{ id: 'higher-context', reason: ' ' }] }));
    expect(silent.fairnessViolations).toEqual(['unavailable-arm-without-reason:higher-context']);
  });
});
