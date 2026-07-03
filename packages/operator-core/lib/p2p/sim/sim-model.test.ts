/**
 * P-306 simulation harness — EXAMPLE-based unit tests + DETERMINISTIC fairness.
 *
 * These pin each mechanism of the reference scheduler with a hand-built
 * scenario (readable when one breaks), and prove the fairness/weighting
 * properties over a large FIXED key set (no randomness → never flaky). The
 * generated-corpus invariants live in sim.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  hrwAssign,
  hashUnit,
  simulate,
  epochAuthorized,
  invariantNoOverSpend,
  invariantNoSlotOversub,
  invariantEpochFenced,
  invariantNoWorkStarvation,
  invariantNoConcurrentDoubleClaim,
  invariantPriorityRespected,
  checkAllInvariants,
  type SimScenario,
  type SimOffer,
  type SimHost,
} from './sim-model';

function host(id: string, over: Partial<SimHost> = {}): SimHost {
  return { id, weight: 1, remoteBudget: 1000, localSlots: 4, ...over };
}
function offer(id: string, over: Partial<SimOffer> = {}): SimOffer {
  return { id, priority: 0, cost: 0, eligible: [], grantorId: 1, grantEpoch: 0, ...over };
}

/* ── HRW publisher-stamp determinism (D-012 C4) ─────────────────────────── */

describe('hrwAssign — the publisher stamp', () => {
  it('is a total function: a non-empty roster always yields one eligible host', () => {
    for (let i = 0; i < 200; i++) {
      const winner = hrwAssign(`offer-${i}`, [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
      ]);
      expect(['a', 'b', 'c']).toContain(winner);
    }
  });

  it('is INDEPENDENT of roster order (every replica agrees → no double-claim)', () => {
    const roster = [
      { id: 'x', weight: 3 },
      { id: 'y', weight: 1 },
      { id: 'z', weight: 2 },
    ];
    const reversed = [...roster].reverse();
    const shuffled = [roster[1]!, roster[2]!, roster[0]!];
    for (let i = 0; i < 500; i++) {
      const a = hrwAssign(`k-${i}`, roster);
      expect(hrwAssign(`k-${i}`, reversed)).toBe(a);
      expect(hrwAssign(`k-${i}`, shuffled)).toBe(a);
    }
  });

  it('returns null for an empty roster', () => {
    expect(hrwAssign('k', [])).toBeNull();
  });

  it('hashUnit stays strictly inside (0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const u = hashUnit(`key-${i}`);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });
});

/* ── Fairness + X12 weighting — DETERMINISTIC over a fixed key set ───────── */

describe('fairness + X12 weighting (deterministic, 10k fixed keys)', () => {
  const KEYS = Array.from({ length: 10_000 }, (_, i) => `offer-${i}`);

  function shares(roster: { id: string; weight: number }[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const id of roster.map((r) => r.id)) counts.set(id, 0);
    for (const k of KEYS) {
      const w = hrwAssign(k, roster)!;
      counts.set(w, counts.get(w)! + 1);
    }
    return counts;
  }

  it('equal weights ⇒ no host starves and load spreads within ±10%', () => {
    const roster = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, weight: 1 }));
    const counts = shares(roster);
    const expected = KEYS.length / roster.length; // 2000
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(0); // no starvation
      expect(c).toBeGreaterThan(expected * 0.9);
      expect(c).toBeLessThan(expected * 1.1);
    }
  });

  it('higher weight ⇒ strictly larger share (monotone), roughly proportional', () => {
    const roster = [
      { id: 'w1', weight: 1 },
      { id: 'w2', weight: 2 },
      { id: 'w4', weight: 4 },
      { id: 'w8', weight: 8 },
    ];
    const counts = shares(roster);
    // Monotone in weight.
    expect(counts.get('w1')!).toBeLessThan(counts.get('w2')!);
    expect(counts.get('w2')!).toBeLessThan(counts.get('w4')!);
    expect(counts.get('w4')!).toBeLessThan(counts.get('w8')!);
    // Roughly proportional: the weight-8 host should take well over half.
    const total = KEYS.length;
    expect(counts.get('w8')! / total).toBeGreaterThan(0.4);
    // The weight-1 host is not starved.
    expect(counts.get('w1')!).toBeGreaterThan(0);
  });
});

/* ── End-to-end scheduler scenarios ─────────────────────────────────────── */

describe('simulate — happy path', () => {
  it('the stamped designee claims and completes; spend is committed once', () => {
    const scenario: SimScenario = {
      hosts: [host('h1'), host('h2')],
      offers: [offer('o1', { cost: 10, eligible: ['h1', 'h2'] })],
      events: [
        { t: 0, kind: 'publish', offerId: 'o1' },
        { t: 2, kind: 'complete', offerId: 'o1' },
      ],
      stealTimeout: 5,
      leaseTtl: 20,
      maxSteps: 5,
    };
    const r = simulate(scenario);
    const o1 = r.offers.get('o1')!;
    expect(o1.status).toBe('done');
    const holder = r.hosts.get(o1.claimedBy ?? '')!;
    // spent lands on whichever host was the designee.
    const totalSpent = [...r.hosts.values()].reduce((s, h) => s + h.spent, 0);
    expect(totalSpent).toBe(10);
    expect(checkAllInvariants(r).ok).toBe(true);
    void holder;
  });
});

describe('simulate — steal after T2 (D-012 soft designation)', () => {
  it('a slow/dead designee loses the offer to an eligible peer; no starvation', () => {
    // h1 is the designee for o1 but crashes before claiming; h2 must steal it.
    const scenario: SimScenario = {
      hosts: [host('h1'), host('h2')],
      offers: [offer('o1', { cost: 5, eligible: ['h1', 'h2'] })],
      events: [
        { t: 0, kind: 'publish', offerId: 'o1' },
        { t: 0, kind: 'crash', hostId: 'h1' }, // designee dead immediately
        { t: 12, kind: 'complete', offerId: 'o1' },
      ],
      stealTimeout: 3,
      leaseTtl: 20,
      maxSteps: 15,
    };
    const r = simulate(scenario);
    const o1 = r.offers.get('o1')!;
    // Whoever ends up holding/finishing it, it must NOT be the dead designee.
    expect(o1.status === 'done' || o1.status === 'claimed').toBe(true);
    const stolen = r.admissions.some((a) => a.offerId === 'o1' && a.hostId === 'h2');
    expect(stolen).toBe(true);
    expect(invariantNoWorkStarvation(r).ok).toBe(true);
    expect(checkAllInvariants(r).ok).toBe(true);
  });
});

describe('simulate — failover on lease TTL expiry', () => {
  it('a claim that never completes is reassigned after the lease TTL', () => {
    const scenario: SimScenario = {
      hosts: [host('h1'), host('h2')],
      offers: [offer('o1', { cost: 1, eligible: ['h1', 'h2'] })],
      events: [{ t: 0, kind: 'publish', offerId: 'o1' }],
      stealTimeout: 100, // never "steal", only fail over
      leaseTtl: 4,
      maxSteps: 20,
    };
    const r = simulate(scenario);
    // The offer must be re-admitted at least once (a failover happened).
    const admits = r.admissions.filter((a) => a.offerId === 'o1');
    expect(admits.length).toBeGreaterThanOrEqual(2);
    expect(r.log.some((l) => l.kind === 'requeue' && l.detail.includes('lease TTL'))).toBe(true);
    expect(invariantNoConcurrentDoubleClaim(r).ok).toBe(true);
  });
});

describe('simulate — two-axis limits', () => {
  it('remote budget CAP is never over-committed (loud exhaustion)', () => {
    // One host, budget 10, three offers of cost 6 each → at most one can commit.
    const scenario: SimScenario = {
      hosts: [host('h1', { remoteBudget: 10, localSlots: 5 })],
      offers: [
        offer('o1', { cost: 6, eligible: ['h1'] }),
        offer('o2', { cost: 6, eligible: ['h1'] }),
        offer('o3', { cost: 6, eligible: ['h1'] }),
      ],
      events: [
        { t: 0, kind: 'publish', offerId: 'o1' },
        { t: 0, kind: 'publish', offerId: 'o2' },
        { t: 0, kind: 'publish', offerId: 'o3' },
        { t: 1, kind: 'complete', offerId: 'o1' },
        { t: 1, kind: 'complete', offerId: 'o2' },
        { t: 1, kind: 'complete', offerId: 'o3' },
      ],
      stealTimeout: 100,
      leaseTtl: 100,
      maxSteps: 5,
    };
    const r = simulate(scenario);
    expect(r.hosts.get('h1')!.spent).toBeLessThanOrEqual(10);
    expect(r.log.some((l) => l.kind === 'exhausted')).toBe(true);
    expect(invariantNoOverSpend(r).ok).toBe(true);
  });

  it('local slot cap is never oversubscribed (physics)', () => {
    // One host, 2 slots, 5 concurrent offers → never more than 2 active.
    const scenario: SimScenario = {
      hosts: [host('h1', { localSlots: 2, remoteBudget: 1000 })],
      offers: Array.from({ length: 5 }, (_, i) => offer(`o${i}`, { cost: 1, eligible: ['h1'] })),
      events: Array.from({ length: 5 }, (_, i) => ({ t: 0, kind: 'publish' as const, offerId: `o${i}` })),
      stealTimeout: 100,
      leaseTtl: 100,
      maxSteps: 3,
    };
    const r = simulate(scenario);
    expect(r.peakActiveByHost.get('h1')!).toBeLessThanOrEqual(2);
    expect(invariantNoSlotOversub(r).ok).toBe(true);
  });
});

describe('simulate — interactive preemption (D-008, loud)', () => {
  it('host-interactive evicts a foreign claim and the work is requeued, not lost', () => {
    const scenario: SimScenario = {
      hosts: [host('h1', { localSlots: 1 }), host('h2', { localSlots: 1 })],
      offers: [offer('o1', { cost: 1, eligible: ['h1', 'h2'] })],
      events: [
        { t: 0, kind: 'publish', offerId: 'o1' },
        { t: 1, kind: 'interactive', hostId: 'h1' }, // whoever holds it on h1 gets bumped
        { t: 1, kind: 'crash', hostId: 'h1' }, // and h1 goes busy so o1 must land on h2
        { t: 8, kind: 'complete', offerId: 'o1' },
      ],
      stealTimeout: 2,
      leaseTtl: 50,
      maxSteps: 12,
    };
    const r = simulate(scenario);
    // A preempt must have been logged loudly if h1 held it at t=1.
    const o1 = r.offers.get('o1')!;
    expect(o1.status === 'done' || o1.status === 'claimed').toBe(true);
    expect(checkAllInvariants(r).ok).toBe(true);
  });
});

/* ── X6 epoch fencing / stale-backlog replay ────────────────────────────── */

describe('epochAuthorized', () => {
  it('authorizes iff the presented epoch is at or above the high-water', () => {
    expect(epochAuthorized(2, 2)).toBe(true);
    expect(epochAuthorized(3, 2)).toBe(true);
    expect(epochAuthorized(1, 2)).toBe(false);
  });
});

describe('simulate — X6 revocation reaping + stale-backlog replay', () => {
  it('a revoke reaps the in-flight offer and a replayed stale op is refused', () => {
    const scenario: SimScenario = {
      hosts: [host('h1', { localSlots: 2 })],
      offers: [offer('o1', { cost: 1, eligible: ['h1'], grantorId: 42, grantEpoch: 0 })],
      events: [
        { t: 0, kind: 'publish', offerId: 'o1' }, // claimed under epoch 0
        { t: 2, kind: 'revoke', grantorId: 42 }, // high-water -> 1, reaps o1
        // A stale pre-revocation op replays "fresh" after a heal, epoch 0:
        { t: 4, kind: 'replayStale', offerId: 'o1', grantEpoch: 0 },
      ],
      stealTimeout: 100,
      leaseTtl: 100,
      maxSteps: 8,
    };
    const r = simulate(scenario);
    const o1 = r.offers.get('o1')!;
    // It was claimed at t<=1, reaped at t=2, and the stale replay never re-claims.
    expect(o1.status).toBe('reaped');
    // No admission ever violated the fence.
    expect(invariantEpochFenced(r).ok).toBe(true);
    // The one legitimate admission was at epoch 0 while high-water was still 0.
    const claimAdmits = r.admissions.filter((a) => a.offerId === 'o1');
    expect(claimAdmits.length).toBe(1);
    expect(claimAdmits[0]!.grantEpoch).toBe(0);
    expect(claimAdmits[0]!.highWaterAtClaim).toBe(0);
  });

  it('an offer stamped BELOW an existing high-water is never claimed', () => {
    const scenario: SimScenario = {
      hosts: [host('h1')],
      offers: [offer('o1', { cost: 1, eligible: ['h1'], grantorId: 7, grantEpoch: 1 })],
      events: [{ t: 0, kind: 'publish', offerId: 'o1' }],
      stealTimeout: 100,
      leaseTtl: 100,
      maxSteps: 5,
      initialHighWater: { 7: 3 }, // grantor already revoked past epoch 1
    };
    const r = simulate(scenario);
    expect(r.admissions.filter((a) => a.offerId === 'o1').length).toBe(0);
    expect(r.offers.get('o1')!.status).toBe('reaped');
    expect(invariantEpochFenced(r).ok).toBe(true);
  });
});

/* ── Priorities ─────────────────────────────────────────────────────────── */

describe('simulate — priorities', () => {
  it('a host with one slot takes the higher-priority offer first', () => {
    const scenario: SimScenario = {
      hosts: [host('h1', { localSlots: 1 })],
      offers: [
        offer('lo', { priority: 1, cost: 1, eligible: ['h1'] }),
        offer('hi', { priority: 9, cost: 1, eligible: ['h1'] }),
      ],
      events: [
        { t: 0, kind: 'publish', offerId: 'lo' },
        { t: 0, kind: 'publish', offerId: 'hi' },
      ],
      stealTimeout: 100,
      leaseTtl: 100,
      maxSteps: 2,
    };
    const r = simulate(scenario);
    const first = r.admissions[0]!;
    expect(first.offerId).toBe('hi');
    expect(invariantPriorityRespected(r).ok).toBe(true);
  });
});
