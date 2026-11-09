/** Door math (deterministic-context-carry P-006, plan D-007) — the decided formula's knees
 *  and the proportional door split, pinned so a constant change is a deliberate test change. */
import { describe, expect, it } from 'vitest';
import {
  BAKED_DOOR_CONSTANTS,
  capInjectionText,
  COMPACTION_OVERHEAD_TOKENS,
  computeCompactionThresholds,
  computeMaxTurn,
  computeTurnDoors,
  DOOR_SPLIT,
  MAX_TURN_CAP_TOKENS,
  MAX_TURN_FLOOR_TOKENS,
  packContextCandidates,
  type ContextCandidate,
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

describe('computeCompactionThresholds (P-007: soft = w − (2×maxTurn + overhead), hard = w − maxTurn)', () => {
  it("reproduces the plan's decided Ornith operating point: soft ~90% / hard ~96% of 204,800", () => {
    const t = computeCompactionThresholds(204_800); // maxTurn = 8000 (floor)
    expect(t).toEqual({ softTokens: 184_800, hardTokens: 196_800, softPct: 90, hardPct: 96 });
  });

  it("reproduces the plan's 400K operating point: soft ~91.5% / hard ~96.25%", () => {
    const t = computeCompactionThresholds(400_000); // maxTurn = 15000 (cap)
    expect(t).toEqual({ softTokens: 366_000, hardTokens: 385_000, softPct: 91, hardPct: 96 });
  });

  it('the overhead constant is exactly what those operating points assume', () => {
    expect(COMPACTION_OVERHEAD_TOKENS).toBe(4_000);
  });

  it('degenerate input never yields negative or inverted thresholds', () => {
    const t = computeCompactionThresholds(0);
    expect(t.softTokens).toBeGreaterThanOrEqual(0);
    expect(t.hardTokens).toBeGreaterThanOrEqual(t.softTokens);
    expect(t.hardPct).toBeGreaterThanOrEqual(t.softPct);
  });
});

describe('DoorConstants parameterization (P-023 — the config surface feeds the same math)', () => {
  it('BAKED_DOOR_CONSTANTS mirrors the exported constants exactly (no drift)', () => {
    expect(BAKED_DOOR_CONSTANTS).toEqual({
      maxTurnFloorTokens: MAX_TURN_FLOOR_TOKENS,
      maxTurnCapTokens: MAX_TURN_CAP_TOKENS,
      maxTurnWindowDivisor: 26,
      doorSplit: DOOR_SPLIT,
      compactionOverheadTokens: COMPACTION_OVERHEAD_TOKENS,
    });
  });

  it('omitting the constants argument is byte-identical to passing BAKED', () => {
    for (const w of [0, 204_800, 400_000, 1_000_000]) {
      expect(computeMaxTurn(w)).toBe(computeMaxTurn(w, BAKED_DOOR_CONSTANTS));
      expect(computeTurnDoors(w)).toEqual(computeTurnDoors(w, BAKED_DOOR_CONSTANTS));
      expect(computeCompactionThresholds(w)).toEqual(computeCompactionThresholds(w, BAKED_DOOR_CONSTANTS));
    }
  });

  it('a custom constant set flows through every function', () => {
    const c = { ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 12_000, compactionOverheadTokens: 6_000 };
    expect(computeMaxTurn(204_800, c)).toBe(12_000); // raised floor binds
    expect(computeTurnDoors(0, c)).toEqual({ maxTurn: 12_000, output: 6_000, resultEach: 2_250, resultSlots: 2, injections: 1_500 });
    const t = computeCompactionThresholds(204_800, c);
    expect(t.softTokens).toBe(204_800 - (2 * 12_000 + 6_000));
    expect(t.hardTokens).toBe(204_800 - 12_000);
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

describe('final context byte packing', () => {
  const unit = (sourceRef: string, text: string, cls: ContextCandidate['class'] = 'ambient', required = false): ContextCandidate =>
    ({ sourceRef, text, revision: 'r1', class: cls, required });

  it.each([0, 1, 255, 4096, 6000, 24000, computeTurnDoors(204_800).injections * 4])(
    'reserves complete required units under byte budget %i, including multibyte framing', budgetBytes => {
      const candidates = [unit('storm', '🌪'.repeat(10_000)), unit('owner', 'Avi: preserve this duty', 'owner', true),
        unit('ctrl', '⟦CTRL⟧', 'control', true), unit('fix', '修正: keep the full correction', 'correction', true),
        unit('short', 'évidence', 'memory')];
      const result = packContextCandidates({ attemptId: 'boundary', budgetBytes, candidates,
        framing: { prefix: '始\n', suffix: '\n終', separator: '\n—\n' } });
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(budgetBytes);
      expect(result.receipt.contextBytes).toBe(Buffer.byteLength(result.text));
      expect(result.receipt.candidates).toHaveLength(candidates.length);
      if (result.receipt.status === 'mandatory-overflow') {
        expect(result.text).toBe('');
        expect(result.selectedIndexes).toEqual([]);
      } else {
        for (const row of candidates.filter(row => row.required)) expect(result.text).toContain(row.text);
        expect(result.selectedIndexes.slice(0, 3)).toEqual([2, 1, 3]);
      }
      expect(result.receipt.tokenEstimate).toEqual({ kind: 'token-proxy-v1', value: Math.ceil(Buffer.byteLength(result.text) / 4), billedTokens: 'UNKNOWN' });
    });

  it('charges separators and suffix exactly, skips oversized optional units without slicing, and retains every identity', () => {
    const candidates = [unit('control', 'é', 'control', true), unit('large', 'never slice me'), unit('small', '字')];
    const full = packContextCandidates({ attemptId: 'exact', budgetBytes: 10, candidates,
      framing: { prefix: '[', separator: '—', suffix: ']' } });
    expect(full.text).toBe('[é—字]');
    expect(full.receipt.contextBytes).toBe(10);
    expect(full.receipt.candidates.map(row => row.reason)).toEqual(['selected', 'budget', 'selected']);
    expect(packContextCandidates({ attemptId: 'one-less', budgetBytes: 9, candidates,
      framing: { prefix: '[', separator: '—', suffix: ']' } }).text).toBe('[é]');
  });

  it('zero and one byte budgets keep mandatory overflow solely in the out-of-band receipt', () => {
    for (const budgetBytes of [0, 1]) {
      const result = packContextCandidates({ attemptId: `attempt-${budgetBytes}`, budgetBytes,
        candidates: [unit('empty', ''), unit('control', '⟦CTRL⟧', 'control', true), unit('ambient', 'a')] });
      expect(result.text).toBe('');
      expect(result.receipt.status).toBe('mandatory-overflow');
      expect(result.receipt.candidates.map(row => row.reason)).toEqual(['empty', 'mandatory-overflow', 'mandatory-overflow']);
      expect(result.receipt.candidates[1]).toMatchObject({ sourceRef: 'control', revision: 'r1', class: 'control', required: true,
        fragmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 10 });
    }
  });
});
