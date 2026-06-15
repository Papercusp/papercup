import { describe, it, expect } from 'vitest';
import { priceRun, resolveModelPrice, PRICE_TABLE_V1 } from './pricing';

describe('resolveModelPrice', () => {
  it('returns the Opus 4.8 row at $5/$25 with derived cache prices', () => {
    const p = resolveModelPrice('claude-opus-4-8');
    expect(p).toEqual({ inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25 });
  });

  it('resolves a suffixed id by longest-prefix match', () => {
    expect(resolveModelPrice('claude-opus-4-8[1m]')).toEqual(resolveModelPrice('claude-opus-4-8'));
  });

  it('returns null for an unknown model', () => {
    expect(resolveModelPrice('gpt-mystery')).toBeNull();
  });
});

describe('priceRun', () => {
  it('prices input and output at table rates', () => {
    expect(priceRun({ tokensIn: 1_000_000, tokensOut: 0 }, 'claude-opus-4-8')).toBeCloseTo(5, 10);
    expect(priceRun({ tokensIn: 0, tokensOut: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(25, 10);
  });

  it('prices cache read and write separately (0.1x / 1.25x input)', () => {
    expect(priceRun({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(0.5, 10);
    expect(priceRun({ tokensIn: 0, tokensOut: 0, tokensCacheWrite: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(6.25, 10);
  });

  it('resolves suffixed model ids', () => {
    expect(priceRun({ tokensIn: 1_000_000, tokensOut: 0 }, 'claude-opus-4-8[1m]')).toBeCloseTo(5, 10);
  });

  it('throws loudly on an unknown model rather than silently zeroing cost', () => {
    expect(() => priceRun({ tokensIn: 1000, tokensOut: 100 }, 'unknown-model')).toThrow(/no price for model/);
  });

  it('table version is pinned', () => {
    expect(PRICE_TABLE_V1.version).toBe('price-table-v1');
  });
});
