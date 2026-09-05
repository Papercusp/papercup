import { describe, expect, it } from 'vitest';
import { settleRevenue, validateRevenueSplit, type RevenueSplitManifest } from './revenue-settlement';

const split: RevenueSplitManifest = { version: 'v1', manifestHash: 'sha256:split', sharesBps: { creator: 2_000, host: 2_000, component: 1_000, dao: 3_000, reserve: 500, tax: 500, operating: 500 } };

describe('DAO revenue settlement', () => {
  it('allocates integer stablecoin micros after provider cost and assigns rounding remainder to DAO', () => {
    const result = settleRevenue({ settlementId: 's-1', grossMicros: 1_000_001n, providerCostMicros: 1n, splitManifest: split, daoTreasury: '0xdao' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const allocations = result.receipt.allocationsMicros;
      expect(Object.values(allocations).reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
      expect(allocations.dao).toBeGreaterThan(0n);
      expect(result.receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('rejects overflowed splits, missing treasury, and cost above gross', () => {
    expect(validateRevenueSplit({ ...split, sharesBps: { ...split.sharesBps, dao: 10_000 } }).ok).toBe(false);
    expect(settleRevenue({ settlementId: 's-2', grossMicros: 1n, providerCostMicros: 0n, splitManifest: split, daoTreasury: '' })).toMatchObject({ ok: false, code: 'missing-treasury' });
    expect(settleRevenue({ settlementId: 's-3', grossMicros: 1n, providerCostMicros: 2n, splitManifest: split, daoTreasury: '0xdao' })).toMatchObject({ ok: false, code: 'cost-exceeds-gross' });
  });
});
