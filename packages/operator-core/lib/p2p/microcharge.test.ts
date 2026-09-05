import { describe, expect, it } from 'vitest';
import { createMicrochargeChannel, paymentVoucherDigest, paymentVoucherSigningBytes, reserveMicrocharge, settleMicrocharge, unsignedVoucher, type CumulativePaymentVoucher } from './microcharge';

const voucher = (overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher => ({
  channelId: 'channel-1', payer: 'buyer', seller: 'host', releaseRef: 'plugin@1.0.0', usageNonce: 'n-1',
  meterQuantity: 1n, pricePerUnitMicros: 3n, priceVersion: 'price-v1', splitManifestHash: 'sha256:split',
  expiresAtMs: 10_000, cumulativeClaimMicros: 3n, signature: 'payer-signature', ...overrides,
});

describe('per-use microcharge vouchers', () => {
  it('uses exact bigint micro-units and binds the complete voucher', () => {
    const v = voucher({ cumulativeClaimMicros: 1_000_000_000_000_001n });
    expect(paymentVoucherSigningBytes(unsignedVoucher(v))).toBeInstanceOf(Buffer);
    expect(paymentVoucherDigest(unsignedVoucher(v))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reserves cumulative deltas before execution and settles actual usage', () => {
    const channel = createMicrochargeChannel('channel-1', 10n);
    const opened = reserveMicrocharge(channel, voucher(), 1_000);
    expect(opened).toMatchObject({ ok: true, deltaMicros: 3n });
    if (!opened.ok) return;
    const settled = settleMicrocharge({ channel: opened.channel, voucher: voucher(), actualAmountMicros: 2n, occurredAtMs: 2_000, receiptSignature: 'host-signature' });
    expect(settled).toMatchObject({ ok: true, receipt: { amountMicros: 2n } });
    if (settled.ok) expect(settled.channel.committedMicros).toBe(2n);
  });

  it('rejects duplicate nonces, regressions, expiry, and cap exhaustion', () => {
    const channel = createMicrochargeChannel('channel-1', 3n);
    const opened = reserveMicrocharge(channel, voucher(), 1_000);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(reserveMicrocharge(opened.channel, voucher(), 1_000)).toMatchObject({ ok: false, code: 'duplicate-nonce' });
    const settled = settleMicrocharge({ channel: opened.channel, voucher: voucher(), occurredAtMs: 1_000, receiptSignature: 'sig' });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(reserveMicrocharge(settled.channel, voucher({ usageNonce: 'n-2', cumulativeClaimMicros: 2n }), 1_000)).toMatchObject({ ok: false, code: 'cumulative-regression' });
    expect(reserveMicrocharge(createMicrochargeChannel('channel-1', 3n), voucher({ usageNonce: 'expired', expiresAtMs: 1 }), 2_000)).toMatchObject({ ok: false, code: 'expired' });
    expect(reserveMicrocharge(createMicrochargeChannel('channel-1', 2n), voucher(), 1_000)).toMatchObject({ ok: false, code: 'cap-exhausted' });
  });
});
