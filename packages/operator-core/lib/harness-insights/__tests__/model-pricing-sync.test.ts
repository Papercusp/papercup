/**
 * model-pricing-sync row-builder tests (B-TOK-ROLL). The DB UPSERT is integration-
 * tier; here we lock the PURE projection: MODEL_PRICES → explicit per-MTok rates
 * (cache_read = cacheRead ?? in×0.1, cache_creation = cacheWrite ?? in×1.25).
 */
import { describe, expect, it } from 'vitest';
import { MODEL_PRICES } from '@papercusp/model-pricing';
import { pricingRowFor, buildPricingRows } from '../model-pricing-sync';

describe('pricingRowFor', () => {
  it('defaults cache-read to 0.1× input and cache-creation to 1.25× input when unset (Anthropic models)', () => {
    const r = pricingRowFor('claude-opus-4-8', { in: 5, out: 25 });
    expect(r).toEqual({
      modelId: 'claude-opus-4-8',
      inputPerMtok: 5,
      outputPerMtok: 25,
      cacheReadPerMtok: 0.5, // 5 × 0.1
      cacheCreationPerMtok: 6.25, // 5 × 1.25
    });
  });

  it('uses EXPLICIT cacheRead / cacheWrite when the entry provides them (gpt-5 family)', () => {
    const r = pricingRowFor('gpt-5.5', { in: 2.5, out: 20, cacheRead: 0.25, cacheWrite: 2.5 });
    expect(r.cacheReadPerMtok).toBe(0.25);
    expect(r.cacheCreationPerMtok).toBe(2.5);
  });
});

describe('buildPricingRows', () => {
  it('projects EVERY MODEL_PRICES entry exactly once (the table is a full mirror)', () => {
    const rows = buildPricingRows();
    expect(rows.length).toBe(Object.keys(MODEL_PRICES).length);
    expect(new Set(rows.map((r) => r.modelId)).size).toBe(rows.length);
  });

  it('every row has positive, finite rates for all four token tiers', () => {
    for (const r of buildPricingRows()) {
      for (const v of [r.inputPerMtok, r.outputPerMtok, r.cacheReadPerMtok, r.cacheCreationPerMtok]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('matches costFromTokens defaults — cache_read is exactly 1/10th of the input rate where unset', () => {
    const opus = buildPricingRows().find((r) => r.modelId === 'claude-opus-4-8')!;
    expect(opus.cacheReadPerMtok).toBeCloseTo(opus.inputPerMtok * 0.1, 9);
    expect(opus.cacheCreationPerMtok).toBeCloseTo(opus.inputPerMtok * 1.25, 9);
  });
});
