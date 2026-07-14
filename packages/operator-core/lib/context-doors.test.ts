/** Door math (deterministic-context-carry P-006, plan D-007) — the decided formula's knees
 *  and the proportional door split, pinned so a constant change is a deliberate test change. */
import { describe, expect, it } from 'vitest';
import {
  capInjectionText,
  computeMaxTurn,
  computeTurnDoors,
  DOOR_SPLIT,
  MAX_TURN_CAP_TOKENS,
  MAX_TURN_FLOOR_TOKENS,
} from './context-doors';

describe('computeMaxTurn (min(15K, max(8K, window/26)))', () => {
  it('the 8K floor binds below ~208K — Ornith 204,800 → exactly the floor', () => {
    expect(computeMaxTurn(204_800)).toBe(8_000); // 204800/26 = 7876 < floor
    expect(computeMaxTurn(32_000)).toBe(8_000);
    expect(computeMaxTurn(207_999)).toBe(8_000);
  });

  it('/26 scaling binds between the knees', () => {
    expect(computeMaxTurn(260_000)).toBe(10_000);
    expect(computeMaxTurn(312_000)).toBe(12_000);
  });

  it('the 15K cap binds above ~390K — a 400K/1M window stops at the cap', () => {
    expect(computeMaxTurn(400_000)).toBe(15_000);
    expect(computeMaxTurn(1_000_000)).toBe(15_000);
  });

  it('degenerate input (0 / NaN / negative) falls back to the floor, never NaN', () => {
    expect(computeMaxTurn(0)).toBe(MAX_TURN_FLOOR_TOKENS);
    expect(computeMaxTurn(Number.NaN)).toBe(MAX_TURN_FLOOR_TOKENS);
    expect(computeMaxTurn(-5)).toBe(MAX_TURN_FLOOR_TOKENS);
  });
});

describe('computeTurnDoors (proportional split inside maxTurn)', () => {
  it('at the 8K floor the split IS the decided default: output 4K / results 2×1.5K / injections 1K', () => {
    expect(computeTurnDoors(204_800)).toEqual({ maxTurn: 8_000, output: 4_000, resultEach: 1_500, resultSlots: 2, injections: 1_000 });
  });

  it('at the 15K cap the doors scale up proportionally and still sum to maxTurn', () => {
    const d = computeTurnDoors(1_000_000);
    expect(d).toEqual({ maxTurn: 15_000, output: 7_500, resultEach: 2_812, resultSlots: 2, injections: 1_875 });
    // floor() rounding may shed a token or two — never overshoot the budget
    expect(d.output + d.resultSlots * d.resultEach + d.injections).toBeLessThanOrEqual(d.maxTurn);
  });

  it('the split proportions sum to exactly 1 (a drifted constant fails HERE, not in production)', () => {
    expect(DOOR_SPLIT.output + DOOR_SPLIT.resultSlots * DOOR_SPLIT.resultEach + DOOR_SPLIT.injections).toBe(1);
    expect(MAX_TURN_FLOOR_TOKENS).toBeLessThan(MAX_TURN_CAP_TOKENS);
  });
});

describe('capInjectionText (P-006 leg (b) — the pure door split)', () => {
  it('text within the budget passes through untouched, overflow null', () => {
    const r = capInjectionText('short wake', 1_000);
    expect(r).toEqual({ kept: 'short wake', overflow: null });
  });

  it('over-budget text splits at a line/space boundary near the budget; kept+overflow reassemble the original', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} of the wake body with some words`).join('\n');
    const r = capInjectionText(text, 100); // 400-char budget
    expect(r.overflow).not.toBeNull();
    expect(r.kept.length).toBeLessThanOrEqual(400);
    expect(r.kept + r.overflow).toBe(text);
    // the cut landed on a boundary, not mid-word (the boundary char leads the overflow)
    expect(r.overflow![0]).toMatch(/[\n ]/);
  });

  it('unbreakable text (no boundary in the tail window) still cuts AT the budget, never over', () => {
    const r = capInjectionText('x'.repeat(2_000), 100);
    expect(r.kept.length).toBe(400);
    expect(r.kept + r.overflow).toBe('x'.repeat(2_000));
  });
});
