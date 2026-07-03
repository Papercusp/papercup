/**
 * P-203 inference leases — EXAMPLE-based unit tests.
 *
 * Drives each lease-lifecycle decision (grant, expiry, epoch fence, clock-skew,
 * the authoritative claim-time revalidation, breach classification) with a
 * hand-built case. The generated invariants live in inference-lease.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  grantLease,
  isLeaseExpired,
  isLeaseEpochFresh,
  assessClockSkew,
  revalidateAtClaim,
  classifyLeaseBreach,
  activeLeasedAmount,
  type InferenceLease,
  type LeaseGrantRequest,
} from './inference-lease';

function req(over: Partial<LeaseGrantRequest> = {}): LeaseGrantRequest {
  return {
    leaseId: 'L1',
    fleetSlug: 'f/hive',
    axis: 'remote',
    amount: 100,
    unit: 'usd-micros',
    ttlMs: 60_000,
    ownerEpoch: 2,
    ...over,
  };
}
function lease(over: Partial<InferenceLease> = {}): InferenceLease {
  return {
    leaseId: 'L1',
    fleetSlug: 'f/hive',
    axis: 'remote',
    amount: 100,
    unit: 'usd-micros',
    grantedAtReceiver: 1000,
    ttlMs: 60_000,
    ownerEpoch: 2,
    ...over,
  };
}

describe('grantLease', () => {
  it('grants within advisory capacity and stamps the RECEIVER clock (H8)', () => {
    const r = grantLease(req({ amount: 50 }), { nowReceiver: 5000, advisoryRemaining: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lease.amount).toBe(50);
      expect(r.lease.grantedAtReceiver).toBe(5000);
      expect(r.lease.ownerEpoch).toBe(2);
    }
  });

  it('refuses amount over advisory capacity (loud)', () => {
    const r = grantLease(req({ amount: 200 }), { nowReceiver: 0, advisoryRemaining: 100 });
    expect(r).toMatchObject({ ok: false, code: 'no_advisory_capacity' });
  });

  it('refuses malformed amount / ttl', () => {
    expect(grantLease(req({ amount: 0 }), { nowReceiver: 0, advisoryRemaining: 100 })).toMatchObject({ ok: false, code: 'invalid_amount' });
    expect(grantLease(req({ ttlMs: 0 }), { nowReceiver: 0, advisoryRemaining: 100 })).toMatchObject({ ok: false, code: 'invalid_ttl' });
  });
});

describe('isLeaseExpired (H8 receiver clock)', () => {
  it('expires strictly after grantedAt + ttl', () => {
    const l = lease({ grantedAtReceiver: 1000, ttlMs: 500 });
    expect(isLeaseExpired(l, 1400)).toBe(false);
    expect(isLeaseExpired(l, 1500)).toBe(false); // exactly at edge — not yet
    expect(isLeaseExpired(l, 1501)).toBe(true);
  });
  it('never expires early on a backwards clock', () => {
    const l = lease({ grantedAtReceiver: 1000, ttlMs: 500 });
    expect(isLeaseExpired(l, 200)).toBe(false);
  });
});

describe('isLeaseEpochFresh (X6)', () => {
  it('a stale epoch is dead regardless of TTL', () => {
    const l = lease({ ownerEpoch: 2, ttlMs: 1e12 }); // huge TTL, never time-expires
    expect(isLeaseEpochFresh(l, 2)).toBe(true);
    expect(isLeaseEpochFresh(l, 3)).toBe(false); // high-water moved past → dead
  });
});

describe('assessClockSkew (H8 — advisory, never gates)', () => {
  it('flags excess skew but is purely diagnostic', () => {
    const within = assessClockSkew({ receiverNow: 1000, senderStamp: 1200, maxSkewMs: 500 });
    expect(within).toMatchObject({ skewMs: -200, withinTolerance: true, flagged: false });
    const excess = assessClockSkew({ receiverNow: 1000, senderStamp: 5000, maxSkewMs: 500 });
    expect(excess.flagged).toBe(true);
    expect(excess.withinTolerance).toBe(false);
  });
});

describe('revalidateAtClaim — leases advise, never replace the gate', () => {
  it('a VALID lease does NOT override a refusing gate', () => {
    const r = revalidateAtClaim({
      lease: lease(),
      gate: { admits: false, reason: 'no headroom' },
      nowReceiver: 2000,
      ownerHighWaterEpoch: 2,
    });
    expect(r).toMatchObject({ ok: false, code: 'gate_refused' });
  });

  it('an expired lease is refused before the gate is consulted', () => {
    const r = revalidateAtClaim({
      lease: lease({ grantedAtReceiver: 0, ttlMs: 100 }),
      gate: { admits: true },
      nowReceiver: 10_000,
      ownerHighWaterEpoch: 2,
    });
    expect(r).toMatchObject({ ok: false, code: 'lease_expired' });
  });

  it('a stale-epoch lease is refused even with an admitting gate + live TTL', () => {
    const r = revalidateAtClaim({
      lease: lease({ ownerEpoch: 1, ttlMs: 1e12 }),
      gate: { admits: true },
      nowReceiver: 1001,
      ownerHighWaterEpoch: 5,
    });
    expect(r).toMatchObject({ ok: false, code: 'lease_epoch_stale' });
  });

  it('admits only when fresh, un-expired, AND the gate admits', () => {
    const r = revalidateAtClaim({
      lease: lease({ grantedAtReceiver: 1000, ttlMs: 5000, ownerEpoch: 3 }),
      gate: { admits: true },
      nowReceiver: 2000,
      ownerHighWaterEpoch: 3,
    });
    expect(r.ok).toBe(true);
  });
});

describe('classifyLeaseBreach (H6/X8)', () => {
  it('preemption is EXCUSED — never dents host reliability', () => {
    const c = classifyLeaseBreach('preemption');
    expect(c).toMatchObject({ receiptKind: 'excused-breach', dentsHostReliability: false });
  });
  it('every other cause dents reliability', () => {
    for (const cause of ['host_reneged', 'host_unreachable', 'budget_exhausted'] as const) {
      const c = classifyLeaseBreach(cause);
      expect(c.receiptKind).toBe('reliability-breach');
      expect(c.dentsHostReliability).toBe(true);
    }
  });
});

describe('activeLeasedAmount', () => {
  it('sums only active (un-expired, epoch-fresh, matching-axis) leases', () => {
    const leases: InferenceLease[] = [
      lease({ leaseId: 'a', axis: 'remote', amount: 10, grantedAtReceiver: 0, ttlMs: 100, ownerEpoch: 2 }), // expired at now=1000
      lease({ leaseId: 'b', axis: 'remote', amount: 20, grantedAtReceiver: 900, ttlMs: 1000, ownerEpoch: 2 }), // active
      lease({ leaseId: 'c', axis: 'remote', amount: 40, grantedAtReceiver: 900, ttlMs: 1000, ownerEpoch: 1 }), // stale epoch
      lease({ leaseId: 'd', axis: 'local', amount: 80, grantedAtReceiver: 900, ttlMs: 1000, ownerEpoch: 2 }), // wrong axis
    ];
    const sum = activeLeasedAmount(leases, { axis: 'remote', nowReceiver: 1000, ownerHighWaterEpoch: 2 });
    expect(sum).toBe(20); // only 'b'
  });
});
