/**
 * P-005 (test-gym): the gym's arm-level compare/select verdict.
 *
 * Proves a finished A/B battery concludes with the substrate's verdict shape:
 * scored-only composite means, errored arms recorded-not-ranked, strict
 * improvement selection — and that the verdict feeds the Scout wire (P-004)
 * unchanged.
 */

import { describe, expect, it } from 'vitest';

import { abVerdict } from './ab-verdict';
import type { AbResult, AbRunOutcome } from './ab-runner';
import { evalVerdictEntries } from '../scout/eval-verdict-wire';

function outcome(over: Partial<AbRunOutcome> & { variantId: string; composite: number }): AbRunOutcome {
  return {
    taskId: 't1',
    repeat: 0,
    runId: `${over.variantId}-${over.taskId ?? 't1'}-${over.repeat ?? 0}`,
    pipelineUsd: 0.1,
    judgeUsd: 0.02,
    ...over,
  } as AbRunOutcome;
}

function resultOf(outcomes: AbRunOutcome[]): AbResult {
  return { outcomes, perTaskVariance: [], cost: { totalUsd: 0, meanRunUsd: 0, perVariant: {} }, comparison: [], rubricHash: 'rh-1' };
}

describe('abVerdict', () => {
  it('ranks candidates by scored-only mean composite and selects the improver', () => {
    const result = resultOf([
      outcome({ variantId: 'A', composite: 0.6 }),
      outcome({ variantId: 'A', composite: 0.7, repeat: 1 }),
      outcome({ variantId: 'B', composite: 0.9 }),
      outcome({ variantId: 'B', composite: 0.85, repeat: 1 }),
    ]);
    const verdict = abVerdict(result, 'A');

    expect(verdict.scenarioId).toBe('gym-ab:rh-1');
    expect(verdict.baseline.metrics['judge:composite']).toBeCloseTo(0.65);
    expect(verdict.candidates[0]!.variantId).toBe('B');
    expect(verdict.candidates[0]!.primaryImprovement).toBeCloseTo(0.225);
    expect(verdict.selected).toBe('B');
  });

  it('excludes rate-limited/errored cells from the composite but not the cost', () => {
    const result = resultOf([
      outcome({ variantId: 'A', composite: 0.5 }),
      outcome({ variantId: 'B', composite: 0.9 }),
      outcome({ variantId: 'B', composite: 0, repeat: 1, status: 'rate_limited' }),
    ]);
    const verdict = abVerdict(result, 'A');
    // composite mean over the ONE scored run, not dragged down by the zero.
    const b = verdict.candidates[0]!;
    expect(b.diffs.find((d) => d.scorerId === 'judge:composite')!.candidate).toBe(0.9);
    // cost averages over BOTH cells (both spent money).
    expect(b.diffs.find((d) => d.scorerId === 'mean-cost-usd')!.candidate).toBeCloseTo(0.12);
  });

  it('a variant with zero scored runs becomes an errored arm, never ranked as zero', () => {
    const result = resultOf([
      outcome({ variantId: 'A', composite: 0.5 }),
      outcome({ variantId: 'B', composite: 0, status: 'errored' }),
    ]);
    const verdict = abVerdict(result, 'A');
    expect(verdict.candidates[0]!.errored).toBe(true);
    expect(verdict.selected).toBeUndefined();
  });

  it('minDelta gates selection; throws on an unknown baseline', () => {
    const result = resultOf([
      outcome({ variantId: 'A', composite: 0.6 }),
      outcome({ variantId: 'B', composite: 0.65 }),
    ]);
    expect(abVerdict(result, 'A', { minDelta: 0.1 }).selected).toBeUndefined();
    expect(() => abVerdict(result, 'nope')).toThrow(/no outcomes/);
  });

  it('the verdict feeds the Scout wire (P-004) unchanged', () => {
    const result = resultOf([
      outcome({ variantId: 'A', composite: 0.6 }),
      outcome({ variantId: 'scout-idea-9', composite: 0.9 }),
    ]);
    const entries = evalVerdictEntries(abVerdict(result, 'A'), new Date('2026-06-10T02:00:00Z'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ref).toBe('eval:gym-ab:rh-1#scout-idea-9');
    expect(entries[0]!.detail).toContain('status: accepted');
  });
});
