import { describe, expect, it } from 'vitest';
import { buildEvmBatchSettlementRequest, validateEvmSettlementConfig } from './evm-settlement';
import { createPaymentChannel } from './payment-channel';

const config = { chainId: 42161, settlementContract: '0x1111111111111111111111111111111111111111', stablecoin: '0x2222222222222222222222222222222222222222', maxBatchSize: 50 } as const;

describe('pilot EVM settlement adapter', () => {
  it('validates config and produces deterministic batch request bytes', () => {
    expect(validateEvmSettlementConfig(config)).toMatchObject({ ok: true });
    const channel = createPaymentChannel('c-1', 'evm-x402', 100n);
    const result = buildEvmBatchSettlementRequest({ config, channel, amountMicros: 7n, voucherDigests: ['a', 'b'] });
    expect(result).toMatchObject({ ok: true, request: { chainId: 42161, to: config.settlementContract, stablecoin: config.stablecoin } });
    if (result.ok) expect(result.request.calldata).toMatch(/^0x[0-9a-f]+$/);
  });

  it('fails closed for wrong rail, invalid address, oversized batch, and escrow overdraw', () => {
    expect(validateEvmSettlementConfig({ ...config, stablecoin: 'bad' }).ok).toBe(false);
    const channel = createPaymentChannel('c-1', 'lightning', 10n);
    expect(buildEvmBatchSettlementRequest({ config, channel, amountMicros: 1n, voucherDigests: ['a'] })).toMatchObject({ ok: false, code: 'wrong-rail' });
    expect(buildEvmBatchSettlementRequest({ config: { ...config, maxBatchSize: 1 }, channel: createPaymentChannel('c-1', 'evm-x402', 10n), amountMicros: 1n, voucherDigests: ['a', 'b'] })).toMatchObject({ ok: false, code: 'batch-too-large' });
    expect(buildEvmBatchSettlementRequest({ config, channel: createPaymentChannel('c-1', 'evm-x402', 1n), amountMicros: 2n, voucherDigests: ['a'] })).toMatchObject({ ok: false, code: 'amount-invalid' });
  });
});
