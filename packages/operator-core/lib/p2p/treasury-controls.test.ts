import { describe, expect, it } from 'vitest';
import { authorizeTreasuryTransfer, validateTreasuryConfig, type SafeTreasuryConfig } from './treasury-controls';

const token = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const config: SafeTreasuryConfig = { chainId: 42161, safeAddress: '0x3333333333333333333333333333333333333333', owners: ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'], threshold: 2, roles: {
  settlement: { enabled: true, maxAmountMicros: 1_000n, allowedRecipients: [recipient], allowedTokens: [token] },
  'host-payout': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
  'reserve-transfer': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
  'emergency-pause': { enabled: true, maxAmountMicros: 0n, allowedRecipients: [recipient], allowedTokens: [token] },
} };

describe('Safe/Zodiac treasury controls', () => {
  it('validates config and authorizes policy-approved bounded settlement', () => {
    expect(validateTreasuryConfig(config)).toEqual({ ok: true });
    const result = authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 7n, settlementReceiptHash: 'receipt-hash', policyApproved: true });
    expect(result).toMatchObject({ ok: true });
  });

  it('fails closed for missing policy approval, allowlist violations, disabled roles, and caps', () => {
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: false })).toMatchObject({ ok: false, code: 'policy-not-approved' });
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient: '0x6666666666666666666666666666666666666666', amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'recipient-not-allowed' });
    expect(authorizeTreasuryTransfer(config, { role: 'host-payout', token, recipient, amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'role-disabled' });
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 1_001n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'amount-exceeds-role-cap' });
  });
});
