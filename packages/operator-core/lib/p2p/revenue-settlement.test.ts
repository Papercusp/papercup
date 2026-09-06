import { describe, expect, it } from 'vitest';
import {
  reconcileSettlement,
  revenueSplitManifest,
  settleRevenue,
  validateRevenueSplit,
  type RevenueSplitManifest,
  type SettlementReceipt,
} from './revenue-settlement';

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

/**
 * P-034 reconciliation invariants.
 *
 * The manifest is DERIVED here rather than hand-written, because reconciliation
 * compares the receipt's committed hash against the deployment's manifest hash:
 * a hand-written `sha256:split` would make every case fail on the hash check
 * before reaching the arithmetic these tests are about.
 */
describe('settlement reconciliation (P-034)', () => {
  const manifest = revenueSplitManifest({ version: 'v1', sharesBps: split.sharesBps });

  function settled(gross = 1_000_001n, cost = 1n): SettlementReceipt {
    const result = settleRevenue({ settlementId: 's-r', grossMicros: gross, providerCostMicros: cost, splitManifest: manifest, daoTreasury: '0xdao' });
    if (!result.ok) throw new Error(`fixture did not settle: ${result.detail}`);
    return result.receipt;
  }

  it('reconciles a receipt this manifest actually produced', () => {
    const result = reconcileSettlement({ receipt: settled(), splitManifest: manifest });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reconciliation.receiptHash).toBe(settled().receiptHash);
      expect(result.reconciliation.distributableMicros).toBe(1_000_000n);
      // 3_000 bps of 1_000_000 is 300_000, and the DAO also carries everything
      // the split does not allocate: these shares sum to 9_500 bps, so the
      // remaining 500 bps (50_000) lands here too. Asserting the TOTAL rather
      // than the nominal share is deliberate — it is the value the treasury
      // door actually transfers, and it is exactly the number a reader would
      // get wrong by reading the bps alone.
      expect(result.reconciliation.allocationsMicros.dao).toBe(350_000n);
    }
  });

  it('refuses a receipt committed to a different split manifest', () => {
    const other = revenueSplitManifest({ version: 'v2', sharesBps: { ...split.sharesBps, dao: 2_000, reserve: 1_500 } });
    expect(reconcileSettlement({ receipt: settled(), splitManifest: other })).toMatchObject({ ok: false, code: 'split-manifest-mismatch' });
  });

  it('refuses a tampered allocation even when the shares still sum to the distributable', () => {
    const receipt = settled();
    // Move 1000 micros from the DAO to the host. The total is untouched, so a
    // reconciliation that only checked the sum would pay the DAO's money to the
    // host and report success.
    const tampered: SettlementReceipt = {
      ...receipt,
      allocationsMicros: {
        ...receipt.allocationsMicros,
        dao: receipt.allocationsMicros.dao - 1_000n,
        host: receipt.allocationsMicros.host + 1_000n,
      },
    };
    const sum = Object.values(tampered.allocationsMicros).reduce((a, b) => a + b, 0n);
    expect(sum).toBe(tampered.distributableMicros);
    expect(reconcileSettlement({ receipt: tampered, splitManifest: manifest })).toMatchObject({ ok: false, code: 'allocation-mismatch' });
  });

  it('refuses a distributable that is not gross minus provider cost', () => {
    const receipt = settled();
    expect(
      reconcileSettlement({ receipt: { ...receipt, providerCostMicros: receipt.providerCostMicros + 5n }, splitManifest: manifest }),
    ).toMatchObject({ ok: false, code: 'distributable-mismatch' });
  });

  it('refuses a negative allocation', () => {
    const receipt = settled();
    // Only `tax` is disturbed. Compensating in `dao` would trip the per-share
    // mismatch on `dao` first (it is checked earlier in REVENUE_SHARES order),
    // so the negative guard under test would never run.
    const negative: SettlementReceipt = { ...receipt, allocationsMicros: { ...receipt.allocationsMicros, tax: -1n } };
    expect(reconcileSettlement({ receipt: negative, splitManifest: manifest })).toMatchObject({ ok: false, code: 'negative-allocation' });
  });

  it('refuses a receipt whose hash does not recompute — the catch-all for fields it does not re-derive', () => {
    const receipt = settled();
    // The settlement id and the treasury address are not re-derived from the
    // manifest, so only the digest can catch them being edited under the row.
    expect(reconcileSettlement({ receipt: { ...receipt, daoTreasury: '0xattacker' }, splitManifest: manifest })).toMatchObject({
      ok: false,
      code: 'receipt-hash-mismatch',
    });
  });
});
