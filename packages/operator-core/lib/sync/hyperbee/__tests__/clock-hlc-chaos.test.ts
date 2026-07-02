/**
 * clock-hlc-chaos.test.ts — Brief AC (shared-hive-release-testing): the
 * CLOCK/TIME-CHAOS robustness audit of the HLC clock-of-record (`HlcClock` +
 * `fed_hlc`, mig-314) that D-001 just shipped to production as the S0 LWW-ordering
 * fix. PG-FREE property + exhaustive unit layer over the PURE HLC core
 * (`@papercusp/locks-core/hlc`) and the substrate's send/recv seams
 * (`stampOpHlc` / `observeRemoteHlc`), plus a federation convergence-under-chaos
 * check over the REAL merge core (reusing Brief D's `FedTsGuardedStore` without
 * editing it).
 *
 * WHY THIS LANE: D-001 proved LWW converges under STATIC forward clock skew. But
 * the HLC has internals the skew test assumed away — a clock running BACKWARDS,
 * an NTP step mid-federation, the 16-bit logical counter near overflow, leap-
 * second / same-physical-ms ties, and long drift. The HLC's whole job is to
 * provide a stable ordering key under exactly these conditions: if a backwards
 * clock or a counter wrap breaks monotonicity, D-001's convergence guarantee
 * silently fails — and it is now load-bearing for the C-001 re-key key-ordering
 * too (a member needs epoch-N's key before epoch-N content, ordered by fed_hlc).
 *
 * S0 if any of these breaks HLC monotonicity or federation convergence.
 *
 * No `Math.random` / `Date.now` — seeded mulberry32 (the rig's `makeRng`) and a
 * controllable physical-clock seam everywhere (the determinism this asserts).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HlcClock,
  compareHlc,
  decodeHlc,
  encodeHlc,
  packHlc,
  unpackHlc,
  HLC_MAX_COUNT,
  HLC_ZERO,
  type Hlc,
} from '@papercusp/locks-core';
import { observeRemoteHlc, stampOpHlc } from '../hlc-stamp';
import { FedTsGuardedStore, makeRng } from './_convergence-fuzz-rig';
import { type AdmittedLog, createMergeCursor, mergeAdmittedLogsIncremental } from '../read-merge';
import type { PeerLogOp } from '../peer-log';

// ---------------------------------------------------------------------------
// Controllable clock seams (seeded; never Date.now / Math.random).
// ---------------------------------------------------------------------------

/** A physical clock fed a seeded CHAOTIC sequence: normal forward drift, big
 *  forward NTP steps, AND backwards jumps (NTP correction / VM pause-resume). */
function chaoticPhysical(seed: number, base = 1_000_000): () => number {
  const rng = makeRng(seed);
  let t = base;
  return () => {
    const r = rng();
    if (r < 0.18) t = Math.max(0, t - Math.floor(rng() * 5000)); // backwards jump
    else if (r < 0.28) t += Math.floor(rng() * 2_000_000); // big forward NTP step
    else t += Math.floor(rng() * 50); // ordinary drift
    return t;
  };
}

/** One single-op in-memory AdmittedLog (local re-impl — touch no shared file). */
function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===========================================================================
// AC.1 — MONOTONICITY UNDER CLOCK CHAOS. send() is STRICTLY INCREASING even when
// the physical clock jumps backward / NTP-steps. The core HLC guarantee.
// ===========================================================================
describe('AC.1 HLC monotonicity — send() strictly increases under backwards clocks + NTP steps', () => {
  it('every successive send() is strictly greater for ANY chaotic physical sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 50, max: 400 }), async (seed, n) => {
        const clock = new HlcClock({ physical: chaoticPhysical(seed) });
        let prev = clock.peek();
        for (let i = 0; i < n; i++) {
          const cur = clock.send();
          expect(compareHlc(prev, cur)).toBeLessThan(0); // strictly greater
          expect(cur.count).toBeLessThanOrEqual(HLC_MAX_COUNT);
          prev = cur;
        }
      }),
      { numRuns: 80, seed: 0xac1 },
    );
  });

  it('explicit NTP step DOWN then UP never regresses ms', () => {
    let phys = 5_000_000;
    const clock = new HlcClock({ physical: () => phys });
    const a = clock.send();
    phys = 1_000_000; // large backward NTP correction
    const b = clock.send();
    expect(b.ms).toBe(a.ms); // ms held; count bumped to stay monotone
    expect(compareHlc(a, b)).toBeLessThan(0);
    phys = 9_000_000; // large forward step
    const c = clock.send();
    expect(c.ms).toBe(9_000_000);
    expect(compareHlc(b, c)).toBeLessThan(0);
  });
});

// ===========================================================================
// AC.2 — COUNTER OVERFLOW / WRAPAROUND. Many ops in ONE physical ms drive the
// 16-bit logical counter to HLC_MAX_COUNT; it must carry ms forward, never
// exceed the ceiling, never collide.
// ===========================================================================
describe('AC.2 counter overflow — 16-bit logical counter carries to the next ms, no collision', () => {
  it('>HLC_MAX_COUNT sends in a single physical ms carry correctly + stay strictly increasing', () => {
    const PHYS = 7_000_000;
    const clock = new HlcClock({ physical: () => PHYS });
    let prev = clock.peek();
    const N = HLC_MAX_COUNT + 50;
    let carried = false;
    for (let i = 0; i < N; i++) {
      const cur = clock.send();
      expect(compareHlc(prev, cur)).toBeLessThan(0); // never collides / regresses
      expect(cur.count).toBeLessThanOrEqual(HLC_MAX_COUNT);
      if (cur.ms > PHYS) carried = true; // ms rolled forward past the frozen physical
      prev = cur;
    }
    expect(carried).toBe(true); // overflow actually exercised (not vacuous)
  });

  it('recv with a remote at the counter ceiling carries instead of overflowing', () => {
    const clock = new HlcClock({ physical: () => 100 });
    const merged = clock.recv({ ms: 100, count: HLC_MAX_COUNT });
    // same ms on both sides + remote at ceiling → must roll ms forward, count 0.
    expect(merged.count).toBeLessThanOrEqual(HLC_MAX_COUNT);
    expect(compareHlc({ ms: 100, count: HLC_MAX_COUNT }, merged)).toBeLessThan(0);
  });
});

// ===========================================================================
// AC.3 — RECV DOMINANCE. recv(remote) returns an HLC ≥ local, ≥ remote, ≥
// physical — the cross-machine happens-before that makes ordering causal.
// ===========================================================================
describe('AC.3 recv dominance — merged HLC dominates local, remote, and physical', () => {
  it('recv result is ≥ each of local / remote / physical for any chaotic inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        // remote drift vs physical, kept WITHIN the ε recv bound (600s) — beyond
        // it recv deliberately refuses to ratchet (WI-1672 poisoning guard, below).
        fc.integer({ min: -5_000_000, max: 600_000 }),
        fc.integer({ min: 0, max: HLC_MAX_COUNT }),
        fc.integer({ min: 0, max: 5_000_000 }),
        async (seed, remoteDrift, remoteCount, physMs) => {
          const clock = new HlcClock({ physical: chaoticPhysical(seed) });
          for (let i = 0; i < 20; i++) clock.send(); // advance to a chaotic local state
          const local = clock.peek();
          const remote: Hlc = { ms: Math.max(0, physMs + remoteDrift), count: remoteCount };
          const merged = clock.recv(remote, physMs);
          expect(compareHlc(local, merged)).toBeLessThanOrEqual(0);
          expect(compareHlc(remote, merged)).toBeLessThanOrEqual(0);
          expect(merged.ms).toBeGreaterThanOrEqual(physMs);
          // and strictly advances the local clock (a later send still increases)
          expect(compareHlc(merged, clock.send())).toBeLessThan(0);
        },
      ),
      { numRuns: 80, seed: 0xac3 },
    );
  });
});

// ===========================================================================
// AC.4 — ENCODE SORT-CONSISTENCY (foundational). The `fed_hlc` PG column stores
// `encodeHlc(...)` as TEXT and orders by string comparison, so string compare
// MUST equal compareHlc — otherwise the production LWW guard orders wrong.
// ===========================================================================
describe('AC.4 encode/decode — string sort == compareHlc; round-trips exact; malformed → ZERO', () => {
  const arbHlc = fc.record({
    ms: fc.integer({ min: 0, max: 999_999_999_999_999 }), // 15-digit ms domain
    count: fc.integer({ min: 0, max: HLC_MAX_COUNT }),
  });

  it('string compare of encodeHlc has the SAME sign as compareHlc', () => {
    fc.assert(
      fc.property(arbHlc, arbHlc, (a, b) => {
        const enc = Math.sign(encodeHlc(a) < encodeHlc(b) ? -1 : encodeHlc(a) > encodeHlc(b) ? 1 : 0);
        expect(enc).toBe(Math.sign(compareHlc(a, b)));
      }),
      { numRuns: 200, seed: 0xac4 },
    );
  });

  it('decodeHlc(encodeHlc(h)) === h', () => {
    fc.assert(
      fc.property(arbHlc, (h) => {
        expect(decodeHlc(encodeHlc(h))).toEqual(h);
      }),
      { numRuns: 200, seed: 0xac4 + 1 },
    );
  });

  it('pack/unpack round-trips within the 48-bit ms / 16-bit count domain', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.integer({ min: 0, max: HLC_MAX_COUNT }), (ms, count) => {
        expect(unpackHlc(packHlc({ ms, count }))).toEqual({ ms, count });
      }),
      { numRuns: 200, seed: 0xac4 + 2 },
    );
  });

  it('decodeHlc on malformed input returns HLC_ZERO (never throws — back-compat)', () => {
    for (const bad of ['', 'garbage', '::', 'abc:def', null, undefined, '123']) {
      expect(decodeHlc(bad as string)).toEqual(HLC_ZERO);
    }
  });
});

// ===========================================================================
// AC.5 — FEDERATION CONVERGENCE UNDER CLOCK CHAOS (the S0 core). Stamp ops
// through the REAL `stampOpHlc` seam on per-author clocks with CHAOTIC physical
// time, fold the same universe in two distinct delivery orders via the REAL
// merge + the shipped `fed_hlc` guard → both peers MUST converge. (Divergence
// here would be an S0 — the brief's headline risk.)
// ===========================================================================
function chaoticOps(seed: number, count: number, keys: number, authors: number): { keyHex: string; op: PeerLogOp }[] {
  const rng = makeRng(seed);
  const clocks = Array.from({ length: authors }, (_, i) => new HlcClock({ physical: chaoticPhysical(seed * 7 + i + 1) }));
  // Per-author monotone write ts (FIFO capture order); the HLC physical chaos
  // lives in each clock's `physical` seam, decoupled from the recorded ts.
  const authorTs = new Array<number>(authors).fill(1000);
  const out: { keyHex: string; op: PeerLogOp }[] = [];
  for (let i = 0; i < count; i++) {
    const author = Math.floor(rng() * authors);
    authorTs[author] += 1 + Math.floor(rng() * 40);
    const ts = authorTs[author];
    const type = rng() < 0.12 ? 'del' : 'put';
    const base: PeerLogOp = {
      type,
      table: 'features-by-id',
      hbKey: `K-${Math.floor(rng() * keys)}`,
      value: { marker: `op${i}`, author, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${author}`,
    };
    out.push({ keyHex: `log-${i}`, op: stampOpHlc(base, clocks[author]) });
  }
  return out;
}

async function foldDigest(ops: { keyHex: string; op: PeerLogOp }[], orderSeed: number): Promise<string> {
  const store = new FedTsGuardedStore('fed_hlc');
  const cursor = createMergeCursor();
  const logs = shuffle(ops, makeRng(orderSeed >>> 0)).map((g) => singleOpLog(g.keyHex, g.op));
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
  return store.digest();
}

describe('AC.5 convergence under clock chaos — distinct delivery orders converge under fed_hlc', () => {
  it('two peers folding the chaotic-clock op universe in different orders reach identical state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const ops = chaoticOps(seed, 50, 6, 4);
        const a = await foldDigest(ops, seed ^ 0x01);
        const b = await foldDigest(ops, seed ^ 0xbeef);
        expect(b).toBe(a); // S0 if this ever fails
      }),
      { numRuns: 60, seed: 0xac5 },
    );
  });

  it('recv seam: observing a remote HLC advances the local clock past it (cross-machine happens-before)', () => {
    const local = new HlcClock({ physical: () => 1000 });
    local.send();
    const remoteHlc = encodeHlc({ ms: 500_000, count: 3 }); // a peer ahead, within the ε recv bound
    observeRemoteHlc(remoteHlc, local);
    const after = local.send(); // a later local write must causally follow the remote
    expect(compareHlc(decodeHlc(remoteHlc), after)).toBeLessThan(0);
  });

  it('recv seam: an ABSURD-future remote HLC does NOT ratchet the clock (WI-1672 amplifier guard)', () => {
    // One poisoned stamp must not pin the clock (and, re-propagated, the whole
    // hive) hours-to-years ahead: past the ε bound the ratchet is refused —
    // the op itself still applies, only the clock advance is skipped.
    const local = new HlcClock({ physical: () => 1000 });
    local.send();
    observeRemoteHlc(encodeHlc({ ms: 8_000_000, count: 3 }), local); // ~2.2h ahead of physical
    expect(local.peek().ms).toBe(1000);
    expect(local.send().ms).toBe(1000); // later stamps stay on honest time
  });
});

// ===========================================================================
// AC.6 — TEETH. Neuter the physical-vs-logical carry (the monotone guard) → the
// backwards-clock monotonicity property goes RED. Proves AC.1 isn't vacuous.
// ===========================================================================
/** A BROKEN clock: sets ms = physical UNCONDITIONALLY (no monotone guard), so a
 *  backwards physical step regresses it — exactly the bug AC.1 forbids. */
class NonMonotoneClock {
  private last: Hlc = { ...HLC_ZERO };
  constructor(private readonly physical: () => number) {}
  send(): Hlc {
    this.last = { ms: this.physical(), count: 0 }; // BUG: ignores last.ms
    return { ...this.last };
  }
}

describe('AC.6 teeth — a clock without the monotone carry REGRESSES under a backwards step', () => {
  it('the broken clock produces a non-increasing pair when physical steps back', () => {
    let phys = 5_000_000;
    const broken = new NonMonotoneClock(() => phys);
    const a = broken.send();
    phys = 1_000_000; // NTP correction backwards
    const b = broken.send();
    expect(compareHlc(a, b)).toBeGreaterThan(0); // REGRESSED == the bug AC.1 catches
  });
});
