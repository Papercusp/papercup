/**
 * failure-detector — φ-accrual + SWIM indirect probing. Pure, deterministic.
 *
 * Algorithm-conformance suite (moved with the lib from operator-core/lib/authority
 * via generalize-libs-to-generic-2026-06-05, row #2). The SWIM peers here are a
 * plain `{ id }` shape with an injected `label` — the lib is generic over the peer
 * type; the host (operator) binds its own peer ref + label when it wires eviction.
 */

import { describe, it, expect } from 'vitest';
import { PhiAccrualDetector, PHI_REVOKE_THRESHOLD } from './phi-accrual';
import { indirectProbe, decideEviction } from './swim-probe';

function feedSteady(d: PhiAccrualDetector, intervalMs: number, count: number, startMs = 0): number {
  let t = startMs;
  for (let i = 0; i < count; i++) {
    d.heartbeat(t);
    t += intervalMs;
  }
  return t - intervalMs; // last arrival time
}

describe('PhiAccrualDetector', () => {
  it('reports 0 suspicion before any heartbeat is observed', () => {
    const d = new PhiAccrualDetector();
    expect(d.phi(123456)).toBe(0);
    expect(d.isAvailable(123456)).toBe(true);
  });

  it('φ is near 0 just after a beat and rises past the threshold as silence grows', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    const last = feedSteady(d, 1000, 30);
    // Right at the last beat → no suspicion.
    expect(d.phi(last)).toBe(0);
    // ~one expected interval later → still low (< the hint level).
    expect(d.phi(last + 1000)).toBeLessThan(1);
    // Far past the expected interval → astronomically suspicious.
    expect(d.phi(last + 10_000)).toBeGreaterThan(PHI_REVOKE_THRESHOLD);
  });

  it('flips isAvailable from true to false as a peer goes silent', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    const last = feedSteady(d, 1000, 30);
    expect(d.isAvailable(last + 500)).toBe(true);
    expect(d.isAvailable(last + 10_000)).toBe(false);
  });

  it('is MORE tolerant of a peer with jittery (high-variance) heartbeats', () => {
    const steady = new PhiAccrualDetector({ minStdDevMs: 50 });
    const jittery = new PhiAccrualDetector({ minStdDevMs: 50 });
    let ts = 0;
    let tj = 0;
    for (let i = 0; i < 30; i++) {
      steady.heartbeat(ts);
      ts += 1000;
      jittery.heartbeat(tj);
      tj += i % 2 === 0 ? 500 : 1500; // mean ~1000 but high variance
    }
    const lastS = ts - 1000;
    const lastJ = tj - 1500;
    // At the same elapsed past the last beat, the jittery peer is LESS suspected.
    expect(jittery.phi(lastJ + 2000)).toBeLessThan(steady.phi(lastS + 2000));
  });
});

describe('SWIM indirect probing', () => {
  interface TestPeer {
    id: string;
  }
  const peer = (id: string): TestPeer => ({ id });
  const label = (p: TestPeer) => p.id;
  const target = peer('target');
  const relays = [peer('r1'), peer('r2'), peer('r3')];

  it('one relay ack clears the suspicion (alive)', async () => {
    const probe = async (r: TestPeer) => r.id === 'r2'; // only r2 reaches target
    const res = await indirectProbe(target, relays, probe, { label });
    expect(res.alive).toBe(true);
    expect(res.confirmedBy).toEqual(['r2']);
    expect(res.deadBy.sort()).toEqual(['r1', 'r3']);
  });

  it('all relays report dead → not alive', async () => {
    const res = await indirectProbe(target, relays, async () => false, { label });
    expect(res.alive).toBe(false);
    expect(res.deadBy.length).toBe(3);
  });

  it('unreachable relays contribute no signal', async () => {
    const res = await indirectProbe(target, relays, async () => {
      throw new Error('relay unreachable');
    }, { label });
    expect(res.alive).toBe(false);
    expect(res.unreachable.length).toBe(3);
    expect(res.confirmedBy.length).toBe(0);
  });

  it('honors k (probe only the first k relays)', async () => {
    let calls = 0;
    await indirectProbe(target, relays, async () => {
      calls++;
      return false;
    }, { k: 2, label });
    expect(calls).toBe(2);
  });

  it('defaults the peer label to String(peer) when no extractor is given', async () => {
    const res = await indirectProbe('target', ['r1', 'r2'], async (r) => r === 'r1');
    expect(res.confirmedBy).toEqual(['r1']);
    expect(res.deadBy).toEqual(['r2']);
  });
});

describe('decideEviction (φ-accrual + SWIM combined)', () => {
  const aliveResult = { alive: true, confirmedBy: ['r1'], deadBy: [], unreachable: [] };
  const deadResult = { alive: false, confirmedBy: [], deadBy: ['r1', 'r2'], unreachable: [] };

  it('keeps a peer whose φ is below the threshold (no probe needed)', () => {
    expect(decideEviction(2, null)).toEqual({ evict: false, reason: 'alive-direct' });
  });

  it('keeps a high-φ peer that a relay confirmed alive (false positive avoided)', () => {
    expect(decideEviction(12, aliveResult)).toEqual({ evict: false, reason: 'alive-indirect' });
  });

  it('evicts only when φ is high AND no relay finds it alive', () => {
    expect(decideEviction(12, deadResult)).toEqual({ evict: true, reason: 'confirmed-dead' });
  });

  it('with no relays, a high φ alone evicts (degrades to the bare detector)', () => {
    expect(decideEviction(12, null)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
  });
});
