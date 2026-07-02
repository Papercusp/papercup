/**
 * hlc — Hybrid Logical Clock unit tests (D-003,
 * locks-correctness-hardening-2026-06-04). Pure algorithm-conformance tests.
 *
 * (The `lwwPick` HLC-integration cases, which test the federation's
 * OpEnvelope tie-break, stay with that adapter in operator-core —
 * `lib/sync/__tests__/lwwpick-hlc.test.ts`.)
 */

import { describe, it, expect } from 'vitest';
import {
  HlcClock,
  compareHlc,
  encodeHlc,
  decodeHlc,
  packHlc,
  unpackHlc,
  normalizeHlcNode,
  newHlcNodeId,
  processHlc,
  _resetProcessHlcForTests,
  HLC_MAX_COUNT,
  HLC_NODE_LEN,
  type Hlc,
} from './hlc';

describe('HLC primitives', () => {
  it('compareHlc orders by ms then count', () => {
    expect(compareHlc({ ms: 1, count: 0 }, { ms: 2, count: 0 })).toBe(-1);
    expect(compareHlc({ ms: 2, count: 0 }, { ms: 1, count: 9 })).toBe(1);
    expect(compareHlc({ ms: 5, count: 1 }, { ms: 5, count: 2 })).toBe(-1);
    expect(compareHlc({ ms: 5, count: 2 }, { ms: 5, count: 2 })).toBe(0);
  });

  it('encode/decode round-trips and is lexicographically sortable', () => {
    const samples: Hlc[] = [
      { ms: 0, count: 0 },
      { ms: 1, count: 9 },
      { ms: 1700000000000, count: 0 },
      { ms: 1700000000000, count: 42 },
      { ms: 1700000000001, count: 0 },
    ];
    for (const h of samples) expect(decodeHlc(encodeHlc(h))).toEqual(h);
    // Sorting the encoded strings == sorting by compareHlc.
    const byCompare = [...samples].sort(compareHlc);
    const byString = [...samples].sort((a, b) => (encodeHlc(a) < encodeHlc(b) ? -1 : 1));
    expect(byString).toEqual(byCompare);
  });

  it('decodeHlc tolerates malformed input', () => {
    expect(decodeHlc(undefined)).toEqual({ ms: 0, count: 0 });
    expect(decodeHlc('')).toEqual({ ms: 0, count: 0 });
    expect(decodeHlc('garbage')).toEqual({ ms: 0, count: 0 });
  });

  it('pack/unpack round-trips through the 8-byte form', () => {
    const h: Hlc = { ms: 1700000000000, count: 4242 };
    expect(unpackHlc(packHlc(h))).toEqual(h);
  });
});

describe('HlcClock', () => {
  it('send() is strictly monotone even when the physical clock stands still', () => {
    const clock = new HlcClock({ physical: () => 1000 });
    const a = clock.send();
    const b = clock.send();
    const c = clock.send();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(a).toEqual({ ms: 1000, count: 0 });
    expect(b).toEqual({ ms: 1000, count: 1 });
    expect(c).toEqual({ ms: 1000, count: 2 });
  });

  it('send() stays monotone across a BACKWARD physical clock step (NTP correction)', () => {
    let now = 5000;
    const clock = new HlcClock({ physical: () => now });
    const a = clock.send(); // ms 5000
    now = 4000; // clock stepped backward
    const b = clock.send();
    const c = clock.send();
    // Monotonicity preserved: ms never regresses, the logical counter advances.
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(b.ms).toBe(5000);
    expect(b.count).toBe(1);
  });

  it('send() resets the counter when the physical clock jumps forward', () => {
    let now = 1000;
    const clock = new HlcClock({ physical: () => now });
    clock.send();
    clock.send(); // ms 1000, count 1
    now = 2000;
    const c = clock.send();
    expect(c).toEqual({ ms: 2000, count: 0 });
  });

  it('recv() advances past the remote frontier and carries causality', () => {
    // Local clock is "behind" the remote's physical time.
    const local = new HlcClock({ physical: () => 1000 });
    local.send(); // {1000,0}
    const remote: Hlc = { ms: 3000, count: 7 };
    const afterRecv = local.recv(remote);
    // New local HLC is >= both inputs.
    expect(compareHlc(afterRecv, remote)).toBe(1);
    expect(afterRecv.ms).toBe(3000);
    // An event stamped AFTER recv causally follows the received event.
    const next = local.send();
    expect(compareHlc(next, remote)).toBe(1);
  });

  it('recv() merges the counter when local, remote and physical share an ms', () => {
    const clock = new HlcClock({ physical: () => 1000 });
    clock.send(); // {1000,0}
    clock.send(); // {1000,1}
    const merged = clock.recv({ ms: 1000, count: 5 });
    // max(local.count=1, remote.count=5) + 1
    expect(merged).toEqual({ ms: 1000, count: 6 });
  });

  it('counter overflow rolls ms forward by one', () => {
    const clock = new HlcClock({ physical: () => 1000, seed: { ms: 1000, count: HLC_MAX_COUNT } });
    const next = clock.send();
    expect(next).toEqual({ ms: 1001, count: 0 });
  });
});

// ── WI-1672: node identity makes the order total across INDEPENDENT clocks ─────
describe('HLC node identity (WI-1672 total order)', () => {
  it('normalizeHlcNode canonicalizes to fixed-width lowercase hex', () => {
    expect(normalizeHlcNode('ABCDEF0123456789')).toBe('abcdef0123456789');
    expect(normalizeHlcNode('e787c7e1a570d58f115565e7d37d7b93f58ee55c')).toBe('e787c7e1a570d58f'); // 64-hex log key → truncated
    expect(normalizeHlcNode('ab-cd')).toBe('abcd000000000000'); // stripped + padded
    expect(normalizeHlcNode('')).toBe('');
    expect(normalizeHlcNode(undefined)).toBe('');
    expect(normalizeHlcNode('zzzz')).toBe(''); // nothing hex left
  });

  it('newHlcNodeId mints HLC_NODE_LEN lowercase hex', () => {
    for (let i = 0; i < 20; i++) expect(newHlcNodeId()).toMatch(new RegExp(`^[0-9a-f]{${HLC_NODE_LEN}}$`));
  });

  it('compareHlc breaks exact (ms, count) ties by node; node-less loses to any node', () => {
    const a: Hlc = { ms: 5, count: 2, node: 'aaaaaaaaaaaaaaaa' };
    const b: Hlc = { ms: 5, count: 2, node: 'bbbbbbbbbbbbbbbb' };
    const legacy: Hlc = { ms: 5, count: 2 };
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(legacy, a)).toBe(-1); // '' < any node — same verdict on every peer
    expect(compareHlc(a, { ...a })).toBe(0); // a genuine full tie = the same stamp replayed
  });

  it('encode/decode round-trips the 3-segment form; string sort == compareHlc across BOTH formats', () => {
    const withNode: Hlc = { ms: 1700000000000, count: 42, node: 'deadbeefdeadbeef' };
    expect(encodeHlc(withNode)).toBe('001700000000000:00042:deadbeefdeadbeef');
    expect(decodeHlc(encodeHlc(withNode))).toEqual(withNode);
    const mixed: Hlc[] = [
      { ms: 1700000000000, count: 42, node: 'ffffffffffffffff' },
      { ms: 1700000000000, count: 42 }, // legacy 2-segment: strict prefix, loses the tie
      { ms: 1700000000000, count: 42, node: '0000000000000001' },
      { ms: 1700000000000, count: 43 },
      { ms: 1699999999999, count: 99999, node: 'aaaaaaaaaaaaaaaa' },
    ];
    const byCompare = [...mixed].sort(compareHlc);
    const byString = [...mixed].sort((a, b) => (encodeHlc(a) < encodeHlc(b) ? -1 : 1));
    expect(byString).toEqual(byCompare);
  });

  it('two independent clocks minting the SAME (ms, count) still produce a total order', () => {
    // The WI-1672 live failure: recv-ratcheted peers advance in counter lockstep.
    const a = new HlcClock({ physical: () => 1000, node: 'aaaaaaaaaaaaaaaa' });
    const b = new HlcClock({ physical: () => 1000, node: 'bbbbbbbbbbbbbbbb' });
    const sa = a.send();
    const sb = b.send();
    expect({ ms: sa.ms, count: sa.count }).toEqual({ ms: sb.ms, count: sb.count }); // the tie
    expect(compareHlc(sa, sb)).not.toBe(0); // …but never an ORDER tie
    expect(encodeHlc(sa) === encodeHlc(sb)).toBe(false);
    // Both peers agree on the winner from either side.
    expect(compareHlc(sa, sb)).toBe(-compareHlc(sb, sa));
  });

  it('recv() never adopts the REMOTE node — returned stamps always carry our identity', () => {
    const clock = new HlcClock({ physical: () => 1000, node: 'aaaaaaaaaaaaaaaa' });
    const merged = clock.recv({ ms: 3000, count: 7, node: 'bbbbbbbbbbbbbbbb' });
    expect(merged.node).toBe('aaaaaaaaaaaaaaaa');
    expect(clock.send().node).toBe('aaaaaaaaaaaaaaaa');
  });

  it('processHlc mints a per-process node identity', () => {
    _resetProcessHlcForTests();
    const stamp = processHlc().send();
    expect(stamp.node).toMatch(new RegExp(`^[0-9a-f]{${HLC_NODE_LEN}}$`));
    _resetProcessHlcForTests();
  });
});

// ── WI-1672 amplifier: the recv ratchet is BOUNDED (ε drift clamp) ─────────────
describe('HlcClock recv drift clamp', () => {
  it('an absurd-future remote does NOT ratchet the clock', () => {
    const clock = new HlcClock({ physical: () => 1_000_000 });
    clock.send(); // {1000000, 0}
    const merged = clock.recv({ ms: 999_999_999_999, count: 42 }); // ~year 2033 vs pt
    expect(merged.ms).toBe(1_000_000); // pinned to physical, not the poison
    expect(clock.send().ms).toBe(1_000_000);
  });

  it('a remote within the ε bound still ratchets (legitimate skew)', () => {
    const clock = new HlcClock({ physical: () => 1_000_000 });
    const merged = clock.recv({ ms: 1_000_000 + 599_000, count: 3 }); // inside default 600s
    expect(merged.ms).toBe(1_599_000);
  });

  it('maxDriftMs is configurable', () => {
    const clock = new HlcClock({ physical: () => 1000, maxDriftMs: 50 });
    expect(clock.recv({ ms: 1100, count: 0 }).ms).toBe(1000); // 100 > 50 → clamped
    expect(clock.recv({ ms: 1040, count: 0 }).ms).toBe(1040); // 40 ≤ 50 → ratchets
  });
});
