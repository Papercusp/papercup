/**
 * P-205 metering + contribution ledger — EXAMPLE-based unit tests.
 *
 * Drives each decision (spend accumulation, per-user capped contribution, the
 * M22 never-per-device rule, and the privacy-preserving advertised view) with a
 * hand-built case. The generated invariants live in metering-ledger.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { InferenceLease } from './inference-lease';
import {
  emptyMeteringLedger,
  recordSpend,
  spentOn,
  recordContribution,
  contributionOf,
  contributionView,
  buildAdvertisedCapacity,
  type MeteringLedger,
} from './metering-ledger';

function seedSpend(entries: Parameters<typeof recordSpend>[1][]): MeteringLedger {
  let l = emptyMeteringLedger();
  for (const e of entries) {
    const r = recordSpend(l, e);
    if (!r.ok) throw new Error(`seed spend failed: ${r.detail}`);
    l = r.ledger;
  }
  return l;
}

describe('recordSpend — per (host, fleet, axis) draw counter', () => {
  it('accumulates same-key draws and reads them back', () => {
    const l = seedSpend([
      { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'remote', amount: 100, unit: 'usd-micros' },
      { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'remote', amount: 50, unit: 'usd-micros' },
    ]);
    expect(spentOn(l, 'host:h1', 'f/a', 'remote')).toBe(150);
  });

  it('keeps distinct (host, fleet, axis) counters separate', () => {
    const l = seedSpend([
      { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'remote', amount: 100, unit: 'usd-micros' },
      { hostRef: 'host:h1', fleetSlug: 'f/b', axis: 'remote', amount: 200, unit: 'usd-micros' },
      { hostRef: 'host:h2', fleetSlug: 'f/a', axis: 'remote', amount: 300, unit: 'usd-micros' },
      { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'local', amount: 5, unit: 'slot-seconds' },
    ]);
    expect(spentOn(l, 'host:h1', 'f/a', 'remote')).toBe(100);
    expect(spentOn(l, 'host:h1', 'f/b', 'remote')).toBe(200);
    expect(spentOn(l, 'host:h2', 'f/a', 'remote')).toBe(300);
    expect(spentOn(l, 'host:h1', 'f/a', 'local')).toBe(5);
    expect(spentOn(l, 'host:h9', 'f/z', 'remote')).toBe(0); // never metered
  });

  it('refuses a non-positive / non-finite amount', () => {
    const l = emptyMeteringLedger();
    expect(recordSpend(l, { hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: 0, unit: 'usd-micros' })).toMatchObject({ ok: false, code: 'invalid_amount' });
    expect(recordSpend(l, { hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: -5, unit: 'usd-micros' })).toMatchObject({ ok: false, code: 'invalid_amount' });
    expect(recordSpend(l, { hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: Infinity, unit: 'usd-micros' })).toMatchObject({ ok: false, code: 'invalid_amount' });
  });

  it('refuses a unit change on an existing counter (H14)', () => {
    const l = seedSpend([{ hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: 10, unit: 'usd-micros' }]);
    expect(recordSpend(l, { hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: 10, unit: 'tokens' })).toMatchObject({ ok: false, code: 'meter_unit_mismatch' });
  });

  it('is immutable — the prior ledger is unchanged', () => {
    const l0 = emptyMeteringLedger();
    const r = recordSpend(l0, { hostRef: 'h', fleetSlug: 'f', axis: 'remote', amount: 10, unit: 'usd-micros' });
    expect(r.ok).toBe(true);
    expect(spentOn(l0, 'h', 'f', 'remote')).toBe(0); // l0 not mutated
  });
});

describe('recordContribution — per attested USER, capped (M22)', () => {
  it('credits the attested user and caps the counter', () => {
    let l = emptyMeteringLedger();
    const r1 = recordContribution(l, { attestedUserId: '279242982', axis: 'local', amount: 600, unit: 'slot-seconds', perUserCap: 1000 });
    expect(r1.ok && r1.credited).toBe(600);
    expect(r1.ok && r1.capped).toBe(false);
    if (r1.ok) l = r1.ledger;
    const r2 = recordContribution(l, { attestedUserId: '279242982', axis: 'local', amount: 600, unit: 'slot-seconds', perUserCap: 1000 });
    // only 400 headroom remains → credited 400, capped
    expect(r2.ok && r2.credited).toBe(400);
    expect(r2.ok && r2.capped).toBe(true);
    if (r2.ok) l = r2.ledger;
    expect(contributionOf(l, '279242982', 'local')).toBe(1000); // never exceeds cap
  });

  it('M22 — credit is keyed by USER, never by device: two machines of one user share ONE counter', () => {
    // The API has no device parameter at all. Two credits from what would be
    // distinct machines (same attested user) sum into the single user counter —
    // a user cannot inflate reciprocity by spinning up VMs.
    let l = emptyMeteringLedger();
    for (const _machine of ['device:laptop', 'device:vm-on-laptop']) {
      const r = recordContribution(l, { attestedUserId: 'user:5', axis: 'remote', amount: 100, unit: 'usd-micros', perUserCap: 1000 });
      if (r.ok) l = r.ledger;
    }
    expect(contributionOf(l, 'user:5', 'remote')).toBe(200); // one shared counter
  });

  it('uncapped (perUserCap null) credits the full amount', () => {
    const r = recordContribution(emptyMeteringLedger(), { attestedUserId: 'u', axis: 'local', amount: 9999, unit: 'tokens', perUserCap: null });
    expect(r.ok && r.credited).toBe(9999);
    expect(r.ok && r.capped).toBe(false);
  });

  it('a credit at/over the cap credits zero and stays capped', () => {
    let l = emptyMeteringLedger();
    const r1 = recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 1000, unit: 'slot-seconds', perUserCap: 1000 });
    if (r1.ok) l = r1.ledger;
    const r2 = recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 1, unit: 'slot-seconds', perUserCap: 1000 });
    expect(r2.ok && r2.credited).toBe(0);
    expect(r2.ok && r2.capped).toBe(true);
  });

  it('refuses invalid amount / cap and a unit change', () => {
    let l = emptyMeteringLedger();
    expect(recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 0, unit: 'tokens', perUserCap: 10 })).toMatchObject({ ok: false, code: 'invalid_amount' });
    expect(recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 5, unit: 'tokens', perUserCap: -1 })).toMatchObject({ ok: false, code: 'invalid_amount' });
    const r = recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 5, unit: 'tokens', perUserCap: 10 });
    if (r.ok) l = r.ledger;
    expect(recordContribution(l, { attestedUserId: 'u', axis: 'local', amount: 5, unit: 'slot-seconds', perUserCap: 10 })).toMatchObject({ ok: false, code: 'meter_unit_mismatch' });
  });

  it('contributionView returns capped served totals per (user, axis)', () => {
    let l = emptyMeteringLedger();
    for (const e of [
      { attestedUserId: 'u1', axis: 'remote' as const, amount: 10, unit: 'usd-micros' as const, perUserCap: null },
      { attestedUserId: 'u1', axis: 'local' as const, amount: 20, unit: 'slot-seconds' as const, perUserCap: null },
      { attestedUserId: 'u2', axis: 'remote' as const, amount: 30, unit: 'usd-micros' as const, perUserCap: null },
    ]) {
      const r = recordContribution(l, e);
      if (r.ok) l = r.ledger;
    }
    const view = contributionView(l, ['u1', 'u2', 'u3']);
    expect(view).toEqual(
      expect.arrayContaining([
        { attestedUserId: 'u1', axis: 'remote', served: 10, unit: 'usd-micros' },
        { attestedUserId: 'u1', axis: 'local', served: 20, unit: 'slot-seconds' },
        { attestedUserId: 'u2', axis: 'remote', served: 30, unit: 'usd-micros' },
      ]),
    );
    expect(view.filter((v) => v.attestedUserId === 'u3')).toEqual([]); // no rows for a user with no contribution
  });
});

describe('buildAdvertisedCapacity — privacy: fleet remainders + lease grants ONLY', () => {
  const ledger = seedSpend([
    { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'remote', amount: 300, unit: 'usd-micros' },
    { hostRef: 'host:h1', fleetSlug: 'f/b', axis: 'remote', amount: 1200, unit: 'usd-micros' }, // over its allotment
    { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'local', amount: 40, unit: 'slot-seconds' },
  ]);
  const activeLeases: InferenceLease[] = [
    { leaseId: 'L1', fleetSlug: 'f/a', axis: 'remote', amount: 100, unit: 'usd-micros', grantedAtReceiver: 1000, ttlMs: 60_000, ownerEpoch: 3 },
  ];

  it('computes remainder = max(0, cap − spent) and floors an over-allotment at 0', () => {
    const adv = buildAdvertisedCapacity({
      hostRef: 'host:h1',
      ledger,
      allotments: [
        { fleetSlug: 'f/a', axis: 'remote', cap: 1000, unit: 'usd-micros' },
        { fleetSlug: 'f/b', axis: 'remote', cap: 1000, unit: 'usd-micros' }, // spent 1200 > cap
        { fleetSlug: 'f/a', axis: 'local', cap: 100, unit: 'slot-seconds' },
      ],
      activeLeases,
    });
    const byFleet = Object.fromEntries(adv.fleetRemainders.map((r) => [`${r.fleetSlug}:${r.axis}`, r.remaining]));
    expect(byFleet['f/a:remote']).toBe(700); // 1000 - 300
    expect(byFleet['f/b:remote']).toBe(0); // floored (spent 1200 > cap 1000)
    expect(byFleet['f/a:local']).toBe(60); // 100 - 40
  });

  it('projects lease grants down to advertised fields ONLY (internal fields stripped)', () => {
    const adv = buildAdvertisedCapacity({ hostRef: 'host:h1', ledger, allotments: [], activeLeases });
    expect(adv.leaseGrants).toHaveLength(1);
    const g = adv.leaseGrants[0]!;
    expect(g).toEqual({ leaseId: 'L1', fleetSlug: 'f/a', axis: 'remote', amount: 100, unit: 'usd-micros' });
    // grantedAtReceiver / ttlMs / ownerEpoch never cross the wire:
    expect(Object.keys(g).sort()).toEqual(['amount', 'axis', 'fleetSlug', 'leaseId', 'unit']);
  });

  it('the advertised object carries NO account total / per-device / contribution field', () => {
    const adv = buildAdvertisedCapacity({
      hostRef: 'host:h1',
      ledger,
      allotments: [{ fleetSlug: 'f/a', axis: 'remote', cap: 1000, unit: 'usd-micros' }],
      activeLeases,
    });
    // Structural guarantee: only these three keys exist.
    expect(Object.keys(adv).sort()).toEqual(['fleetRemainders', 'hostRef', 'leaseGrants']);
    for (const r of adv.fleetRemainders) {
      expect(Object.keys(r).sort()).toEqual(['axis', 'fleetSlug', 'remaining', 'unit']);
    }
  });

  it('a mismatched-unit counter is treated as un-comparable — advertises the untouched cap', () => {
    // ledger meters f/a remote in usd-micros; the allotment claims tokens → no wrong-unit subtraction.
    const adv = buildAdvertisedCapacity({
      hostRef: 'host:h1',
      ledger,
      allotments: [{ fleetSlug: 'f/a', axis: 'remote', cap: 500, unit: 'tokens' }],
      activeLeases: [],
    });
    expect(adv.fleetRemainders[0]!.remaining).toBe(500); // cap untouched, not 500-300
  });
});
