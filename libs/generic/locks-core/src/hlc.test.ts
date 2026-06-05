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
  HLC_MAX_COUNT,
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
