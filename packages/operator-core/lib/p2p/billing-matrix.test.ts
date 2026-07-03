import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  BILLING_MODES,
  type BillingMode,
  X7_AUTHORITY_TABLE,
  authoritativeMeterFor,
  isReceiptAloneAuthoritative,
  resolveBillingAuthority,
} from './billing-matrix';

describe('X7 authority table (P-204)', () => {
  it('has an exhaustive, self-consistent entry per billing mode', () => {
    for (const mode of BILLING_MODES) {
      const spec = X7_AUTHORITY_TABLE[mode];
      expect(spec.mode).toBe(mode);
      expect(spec.rationale.length).toBeGreaterThan(0);
    }
  });

  it('maps each mode to its authoritative meter', () => {
    expect(authoritativeMeterFor('host-pays')).toBe('host-signed-receipts');
    expect(authoritativeMeterFor('pool-with-attribution')).toBe('receipts-plus-reconciliation');
    expect(authoritativeMeterFor('provider-capped-key')).toBe('provider-billing');
  });

  it('only host-pays settles on receipts alone (M8); the others need a cross-check', () => {
    expect(isReceiptAloneAuthoritative('host-pays')).toBe(true);
    expect(isReceiptAloneAuthoritative('pool-with-attribution')).toBe(false);
    expect(isReceiptAloneAuthoritative('provider-capped-key')).toBe(false);
  });
});

describe('resolveBillingAuthority', () => {
  it('host-pays resolves with no pool needed', () => {
    const r = resolveBillingAuthority('host-pays');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.authoritativeMeter).toBe('host-signed-receipts');
  });

  it('pool-with-attribution requires a single-owner pool (M17)', () => {
    expect(resolveBillingAuthority('pool-with-attribution', { pool: { singleOwner: true } }).ok).toBe(true);
    const noPool = resolveBillingAuthority('pool-with-attribution');
    expect(noPool.ok).toBe(false);
    if (!noPool.ok) expect(noPool.code).toBe('pool_not_single_owner');
    const multi = resolveBillingAuthority('pool-with-attribution', { pool: { singleOwner: false } });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.code).toBe('pool_not_single_owner');
  });

  it('provider-capped-key resolves to provider billing', () => {
    const r = resolveBillingAuthority('provider-capped-key');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.authoritativeMeter).toBe('provider-billing');
  });

  it('refuses a streaming/proxy gateway relay in v1 (D-009), for ANY mode', () => {
    for (const mode of BILLING_MODES) {
      const r = resolveBillingAuthority(mode, { pool: { singleOwner: true }, gatewayLeg: 'streaming-relay' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('relay_forbidden_v1');
    }
  });

  it('accepts the quota-ledger gateway leg', () => {
    const r = resolveBillingAuthority('host-pays', { gatewayLeg: 'quota-ledger' });
    expect(r.ok).toBe(true);
  });

  it('refuses an unknown billing mode', () => {
    const r = resolveBillingAuthority('proxy-everything' as BillingMode);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_billing_mode');
  });
});

describe('resolveBillingAuthority (property)', () => {
  it('with a valid context every mode resolves to its table spec', () => {
    fc.assert(
      fc.property(fc.constantFrom(...BILLING_MODES), (mode) => {
        const r = resolveBillingAuthority(mode, { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.spec).toEqual(X7_AUTHORITY_TABLE[mode]);
      }),
    );
  });

  it('a non-quota-ledger leg is refused regardless of mode/pool', () => {
    fc.assert(
      fc.property(fc.constantFrom(...BILLING_MODES), fc.string({ minLength: 1 }).filter((s) => s !== 'quota-ledger'), fc.boolean(), (mode, leg, singleOwner) => {
        const r = resolveBillingAuthority(mode, { pool: { singleOwner }, gatewayLeg: leg });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('relay_forbidden_v1');
      }),
    );
  });

  it('pool-with-attribution resolves iff the pool is single-owner', () => {
    fc.assert(
      fc.property(fc.boolean(), (singleOwner) => {
        const r = resolveBillingAuthority('pool-with-attribution', { pool: { singleOwner } });
        expect(r.ok).toBe(singleOwner);
      }),
    );
  });
});
