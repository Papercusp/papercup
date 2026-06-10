/**
 * P-006 (test-gym): the coordination eval — first deterministic eval on the
 * substrate. Zero LLM: every number is counted off the real lock matrix.
 *
 * The end-to-end case IS the framework proof the plan asks for: a real ranked
 * verdict from a real scenario pair (baseline coarse-lock policy vs candidate
 * policies), produced by the shared compare/select core.
 */

import { describe, expect, it } from 'vitest';

import {
  contendedWorkload,
  runCoordinationEval,
  runCoordinationScenario,
  type CoordPolicyVariant,
  type CoordScenario,
} from './coordination-eval';

const MSG = { intentChars: 80, queueChars: 40 };

function policy(over: Partial<CoordPolicyVariant> & { id: string }): CoordPolicyVariant {
  return { granularity: 'file', onBlock: 'retry', ...MSG, ...over };
}

function scenario(over: Partial<CoordScenario> = {}): CoordScenario {
  return { agents: contendedWorkload({ agents: 4, editsPerAgent: 6, dirs: 2 }), maxTicks: 200, ...over };
}

describe('runCoordinationScenario', () => {
  it('is deterministic — identical metrics on a re-run', () => {
    const p = policy({ id: 'p', granularity: 'directory' });
    const a = runCoordinationScenario(scenario(), p);
    const b = runCoordinationScenario(scenario(), p);
    expect(a).toEqual(b);
  });

  it('file granularity never blocks on the unique-files workload (IX ancestors coexist)', () => {
    const m = runCoordinationScenario(scenario(), policy({ id: 'fine' }));
    expect(m.blocked).toBe(0);
    expect(m.lockBlockRate).toBe(0);
    expect(m.completed).toBe(true);
  });

  it('directory granularity collides on shared dirs (X-vs-X at the dir node)', () => {
    const m = runCoordinationScenario(scenario(), policy({ id: 'coarse', granularity: 'directory' }));
    expect(m.blocked).toBeGreaterThan(0);
    expect(m.lockBlockRate).toBeGreaterThan(0);
    expect(m.completed).toBe(true); // contention slows it, never wedges it
  });

  it('queue policy trades attempts for coord traffic vs retry under the same contention', () => {
    const retry = runCoordinationScenario(scenario(), policy({ id: 'r', granularity: 'directory', onBlock: 'retry' }));
    const queue = runCoordinationScenario(scenario(), policy({ id: 'q', granularity: 'directory', onBlock: 'queue' }));
    expect(queue.attempts).toBeLessThan(retry.attempts);
    expect(queue.coordChars).toBeGreaterThan(retry.coordChars);
    // Both finish the same workload.
    expect(queue.completed).toBe(true);
    expect(retry.completed).toBe(true);
  });

  it('a too-small tick cap records an incomplete run instead of looping', () => {
    const m = runCoordinationScenario(scenario({ maxTicks: 3 }), policy({ id: 'capped', granularity: 'directory' }));
    expect(m.completed).toBe(false);
    expect(m.ticksToComplete).toBe(3);
  });
});

describe('runCoordinationEval — the end-to-end framework proof', () => {
  it('produces a real ranked verdict: fine-grained locking beats the coarse baseline', () => {
    const result = runCoordinationEval({
      scenario: scenario(),
      baseline: policy({ id: 'incumbent', granularity: 'directory', onBlock: 'retry' }),
      candidates: [
        policy({ id: 'fine-grained', granularity: 'file', onBlock: 'retry' }),
        policy({ id: 'queued-coarse', granularity: 'directory', onBlock: 'queue' }),
      ],
    });

    expect(result.scenarioId).toBe('coordination-eval');
    expect(result.primaryScorer).toBe('lock-block-rate');

    // The verdict is REAL: baseline measured a positive block rate, the
    // fine-grained candidate measured zero, and the diff ranks it first.
    expect(result.baseline.metrics['lock-block-rate']).toBeGreaterThan(0);
    expect(result.candidates[0]!.variantId).toBe('fine-grained');
    expect(result.candidates[0]!.primaryImprovement).toBeGreaterThan(0);
    expect(result.selected).toBe('fine-grained');

    // Every arm carries all three counted metrics.
    for (const c of result.candidates) {
      expect(c.diffs.map((d) => d.scorerId).sort()).toEqual(
        ['coord-chars', 'lock-block-rate', 'ticks-to-complete'],
      );
    }
  });

  it('baseline holds when no candidate strictly improves the primary metric', () => {
    const base = policy({ id: 'already-fine', granularity: 'file' });
    const result = runCoordinationEval({
      scenario: scenario(),
      baseline: base,
      candidates: [policy({ id: 'same-policy-again', granularity: 'file' })],
    });
    expect(result.selected).toBeUndefined();
    expect(result.selectionReason).toContain('baseline_holds');
  });
});
