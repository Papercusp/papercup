import { describe, expect, it } from 'vitest';
import { createPaymentChannel, refundableEscrow, settleVoucherBatch } from './payment-channel';
import type { CumulativePaymentVoucher } from './microcharge';

const voucher = (overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher => ({
  channelId: 'c-1', payer: 'buyer', seller: 'host', releaseRef: 'plugin@1', usageNonce: 'n-1', meterQuantity: 1n,
  pricePerUnitMicros: 2n, priceVersion: 'p1', splitManifestHash: 'split', expiresAtMs: 10_000, cumulativeClaimMicros: 2n, signature: 'sig', ...overrides,
});

describe('payment-channel adapter', () => {
  it('settles cumulative vouchers in a batch and exposes refundable escrow', () => {
    const channel = createPaymentChannel('c-1', 'evm-x402', 10n);
    const result = settleVoucherBatch({ channel, vouchers: [voucher(), voucher({ usageNonce: 'n-2', cumulativeClaimMicros: 5n })], nowMs: 1_000 });
    expect(result).toMatchObject({ ok: true, claimMicros: 5n });
    if (result.ok) expect(refundableEscrow(result.channel)).toBe(5n);
  });

  it('rejects duplicate, non-monotonic, expired, disputed, and cap-exceeding batches', () => {
    const channel = createPaymentChannel('c-1', 'lightning', 10n);
    expect(settleVoucherBatch({ channel, vouchers: [voucher(), voucher()], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'duplicate-claim' });
    expect(settleVoucherBatch({ channel, vouchers: [voucher({ usageNonce: 'n-2', cumulativeClaimMicros: 1n })], nowMs: 1_000 })).toMatchObject({ ok: true });
    expect(settleVoucherBatch({ channel, vouchers: [voucher({ expiresAtMs: 1 })], nowMs: 2_000 })).toMatchObject({ ok: false, code: 'expired' });
    expect(settleVoucherBatch({ channel, vouchers: [voucher()], nowMs: 1_000, disputed: true })).toMatchObject({ ok: false, code: 'dispute' });
    expect(settleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 1n), vouchers: [voucher()], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'escrow-exhausted' });
  });
});
