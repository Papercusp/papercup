import { describe, expect, it } from 'vitest';
import {
  LOCAL_ADMISSION_LEASE_SCHEMA_VERSION,
  LocalAdmissionLeasePool,
  type LocalAdmissionLease,
} from './local-admission-lease';

function lease(overrides: Partial<LocalAdmissionLease> = {}): LocalAdmissionLease {
  return {
    schemaVersion: LOCAL_ADMISSION_LEASE_SCHEMA_VERSION,
    leaseId: 'lease-1',
    generation: 1,
    admissionClass: 'agent',
    resourceScope: ['provider'],
    issuedAtMs: 1_000,
    expiresAtMs: 2_000,
    authorityExpiresAtMs: 1_500,
    remainingCredit: 2,
    ...overrides,
  };
}

describe('LocalAdmissionLeasePool', () => {
  it('atomically spends only matching live scoped credit', () => {
    const pool = new LocalAdmissionLeasePool();
    pool.publish(lease());
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toMatchObject({
      admitted: true,
      via: 'lease',
      remainingCredit: 1,
    });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toMatchObject({
      admitted: true,
      remainingCredit: 0,
    });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toEqual({
      admitted: false,
      reason: 'credit-exhausted',
      generation: 1,
    });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['database'], atMs: 1_100 })).toMatchObject({
      admitted: false,
      reason: 'no-matching-lease',
    });
  });

  it('invalidates old credit on a new controller generation', () => {
    const pool = new LocalAdmissionLeasePool();
    pool.publish(lease({ remainingCredit: 100 }));
    pool.observeAuthority({ generation: 2, available: true });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toEqual({
      admitted: false,
      reason: 'stale-generation',
      generation: 2,
    });
    expect(() => pool.publish(lease())).toThrow(/stale local admission generation/);
  });

  it('expires on either lease lifetime or authority heartbeat and supports explicit revocation', () => {
    const pool = new LocalAdmissionLeasePool();
    pool.publish(lease({ remainingCredit: 10 }));
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_500 })).toMatchObject({
      admitted: false,
      reason: 'expired',
    });

    const replacement = lease({ leaseId: 'lease-2', generation: 2, authorityExpiresAtMs: 1_900 });
    pool.publish(replacement);
    expect(pool.revoke('lease-2')).toBe(true);
    expect(pool.revoke('lease-2')).toBe(false);
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_200 })).toMatchObject({
      admitted: false,
      reason: 'stale-generation',
    });
  });

  it('freezes ordinary starts when the governor is unavailable but preserves running/control traffic', () => {
    const pool = new LocalAdmissionLeasePool();
    pool.publish(lease());
    pool.observeAuthority({ generation: 1, available: false });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toEqual({
      admitted: false,
      reason: 'governor-unavailable',
      generation: 1,
    });
    expect(pool.tryAdmit({ admissionClass: 'agent', traffic: 'running', atMs: 1_100 })).toEqual({
      admitted: true,
      via: 'protected',
      generation: 1,
    });
    expect(pool.tryAdmit({ admissionClass: 'control', atMs: 1_100 })).toEqual({
      admitted: true,
      via: 'protected',
      generation: 1,
    });
  });

  it('never carries unspent credit into a replacement lease', () => {
    const pool = new LocalAdmissionLeasePool();
    pool.publish(lease({ remainingCredit: 50 }));
    pool.publish(lease({ leaseId: 'lease-2', generation: 2, remainingCredit: 1 }));
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toMatchObject({
      admitted: true,
      generation: 2,
      remainingCredit: 0,
    });
    expect(pool.tryAdmit({ admissionClass: 'agent', resources: ['provider'], atMs: 1_100 })).toMatchObject({
      admitted: false,
      reason: 'credit-exhausted',
    });
  });

  it('rejects malformed or conflicting lease publications', () => {
    const pool = new LocalAdmissionLeasePool();
    expect(() => pool.publish(lease({ remainingCredit: -1 }))).toThrow(/remainingCredit/);
    expect(() => pool.publish(lease({ authorityExpiresAtMs: 2_001 }))).toThrow(/authorityExpiresAtMs/);
    pool.publish(lease());
    expect(() => pool.publish(lease({ remainingCredit: 3 }))).toThrow(/different content/);
  });
});
