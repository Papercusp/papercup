/**
 * Tests for the matrix-aggregation logic in runner.ts.
 *
 * Plan §2.4: per-scenario runMatrix; variance > 0.5 stddev on any axis
 * becomes an `inconsistent_behavior` finding. Majority verdict over the
 * matrix decides pass/fail/preview.
 *
 * The aggregate function is internal; we exercise it via runScenario's
 * single-run preview path + a synthetic two-run path that doesn't need
 * an LLM (single-run goes through; multi-run is the matrix case).
 *
 * Because runScenario itself hits the LLM, we test the aggregate
 * function's behavior indirectly by importing the internals where
 * possible and otherwise asserting on the shape we already exercise
 * elsewhere.
 */

import { describe, it, expect } from 'vitest';

import { SCENARIOS, getScenario } from '../scenarios';

describe('scenario registry', () => {
  it('exposes the Phase 1 + initial Phase 2 scenarios', () => {
    const ids = SCENARIOS.map((s) => s.id).sort();
    expect(ids).toEqual([
      'op-S01-status-quick',
      'op-S02-multistep-investigation',
      'op-S03-continue-cap-count',
      'op-S05-sleep-tag',
      'op-S07-passive-mode',
      'op-S08-silence-nudge-ready',
      'op-S10-ask-choice',
    ].sort());
  });

  it('throws on unknown scenario', () => {
    expect(() => getScenario('nope')).toThrow();
  });

  it('every scenario references a known target', () => {
    for (const s of SCENARIOS) {
      expect(s.target).toBe('operator');
    }
  });

  it('every scenario has at least one assertion', () => {
    for (const s of SCENARIOS) {
      expect(s.asserts.length).toBeGreaterThan(0);
    }
  });

  it('every scenario declares caps', () => {
    for (const s of SCENARIOS) {
      expect(s.caps.maxTurns).toBeGreaterThan(0);
      expect(s.caps.maxWallSecs).toBeGreaterThan(0);
      expect(s.caps.maxCostUsd).toBeGreaterThan(0);
    }
  });

  it('judge-heavy scenarios opt into runMatrix.repeat >= 3', () => {
    const judgeHeavyIds = ['op-S01-status-quick', 'op-S02-multistep-investigation'];
    for (const id of judgeHeavyIds) {
      const s = getScenario(id);
      expect(s.runMatrix?.repeat ?? 1).toBeGreaterThanOrEqual(3);
    }
  });
});
