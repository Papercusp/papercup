/**
 * authority-hardening — fencing + anti-flap unit tests (D-006,
 * locks-correctness-hardening-2026-06-04). Pure, deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  decideAuthority,
  fenceValid,
  canEnforce,
  staleWindowMs,
  type AuthorityRecord,
  type HardeningTiming,
} from '../authority-hardening';

const T: HardeningTiming = { heartbeatMs: 1000 }; // stale 3000, grace 1000, cooldown 2000

describe('timing windows', () => {
  it('TTL defaults to 3× heartbeat, plus per-peer jitter', () => {
    expect(staleWindowMs({ heartbeatMs: 1000 })).toBe(3000);
    expect(staleWindowMs({ heartbeatMs: 1000, jitter: 0.5 })).toBe(3500);
    expect(staleWindowMs({ heartbeatMs: 1000, staleMs: 5000 })).toBe(5000);
  });
});

describe('decideAuthority', () => {
  it('first election mints epoch 1 and enters the grace window', () => {
    const d = decideAuthority('aaa', false, null, 100, T);
    expect(d).toEqual({ pubkey: 'aaa', epoch: 1, electedAtMs: 100, changed: true, withinGrace: true });
  });

  it('returns null when there is no live candidate', () => {
    expect(decideAuthority(null, false, null, 100, T)).toBeNull();
  });

  it('carries the epoch unchanged while the incumbent keeps winning', () => {
    const prior: AuthorityRecord = { pubkey: 'aaa', epoch: 4, electedAtMs: 1000 };
    const d = decideAuthority('aaa', true, prior, 5000, T)!;
    expect(d.changed).toBe(false);
    expect(d.epoch).toBe(4);
    expect(d.pubkey).toBe('aaa');
    expect(d.withinGrace).toBe(false); // 5000 > electedAt(1000)+grace(1000)
  });

  it('NO-PREEMPTION: a returning lower peer cannot steal a live incumbent within cooldown', () => {
    // Incumbent 'mmm' elected at 1000; cooldown = 2000 → protected until 3000.
    const prior: AuthorityRecord = { pubkey: 'mmm', epoch: 7, electedAtMs: 1000 };
    // 'aaa' (lower pubkey) returns at t=2500 and is live — but mmm is still live + in cooldown.
    const d = decideAuthority('aaa', true, prior, 2500, T)!;
    expect(d.pubkey).toBe('mmm'); // hysteresis kept the incumbent
    expect(d.changed).toBe(false);
    expect(d.epoch).toBe(7);
  });

  it('fails over (epoch++) once the incumbent is gone — not live', () => {
    const prior: AuthorityRecord = { pubkey: 'mmm', epoch: 7, electedAtMs: 1000 };
    // mmm stopped heartbeating (priorLive=false): 'aaa' takes over immediately.
    const d = decideAuthority('aaa', false, prior, 2500, T)!;
    expect(d.pubkey).toBe('aaa');
    expect(d.changed).toBe(true);
    expect(d.epoch).toBe(8); // fencing token advances
    expect(d.electedAtMs).toBe(2500);
    expect(d.withinGrace).toBe(true);
  });

  it('fails over (epoch++) when a live incumbent is preempted AFTER the cooldown elapses', () => {
    const prior: AuthorityRecord = { pubkey: 'mmm', epoch: 7, electedAtMs: 1000 };
    // t=4000 > electedAt(1000)+cooldown(2000) → cooldown over; 'aaa' wins.
    const d = decideAuthority('aaa', true, prior, 4000, T)!;
    expect(d.pubkey).toBe('aaa');
    expect(d.changed).toBe(true);
    expect(d.epoch).toBe(8);
  });
});

describe('fencing + RCU grace', () => {
  it('fenceValid accepts a current-or-newer epoch, rejects a stale one', () => {
    expect(fenceValid(8, 8)).toBe(true);
    expect(fenceValid(9, 8)).toBe(true);
    expect(fenceValid(7, 8)).toBe(false); // a stale ex-authority's grant is fenced out
  });

  it('canEnforce is false during the RCU grace window, true after', () => {
    const d = { pubkey: 'aaa', epoch: 8, electedAtMs: 2000, changed: true, withinGrace: true };
    expect(canEnforce(d, 2500, T)).toBe(false); // 2500 < 2000 + grace(1000)
    expect(canEnforce(d, 3000, T)).toBe(true); // 3000 >= 3000
  });
});
