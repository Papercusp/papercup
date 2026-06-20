/**
 * version-skew-mixed-hlc-backcompat.test.ts — Brief Y (version-skew / rolling
 * upgrade) federation BACK-COMPAT core + the close-out of Brief AC scenario 6
 * (mixed pre-314 / no-HLC rows under the fed_hlc fallback).
 *
 * THE GAP: every existing HLC test universe is HOMOGENEOUS in HLC presence —
 *   - `_convergence-fuzz-rig` / AG / AC stamp EVERY op (`stampOpHlc` always sets
 *     `hlc`), so they only ever exercise the BOTH-SIDES-HLC path.
 *   - `lww-hlc-fedts-divergence.test.ts` is also all-HLC (it characterises the
 *     HLC-vs-fed_ts inversion the D-001 fix removed).
 * But a real ROLLING UPGRADE is the MIXED case: a not-yet-upgraded (pre-314,
 * P-010) peer's writes carry NO `hlc` and order by `fed_ts`, while an upgraded
 * peer's writes carry one. The shipped `fed_hlc` guard handles this by FALLING
 * BACK to `fed_ts` whenever EITHER side lacks an HLC (mig-314 + the projection
 * writeToPg; modelled line-for-line by `_convergence-fuzz-rig`'s
 * `FedTsGuardedStore('fed_hlc')`).
 *
 * WHAT THIS FINDS:
 *   - MONOTONE clocks: a federation MIXING pre-314 (no-HLC) and post-314 (HLC)
 *     peers CONVERGES across the full no-HLC fraction sweep (0%→100%) — the
 *     rolling-upgrade back-compat guarantee for the normal case. ✓ GREEN.
 *   - SKEW clocks (recv-advance inversions): it does NOT always converge. lwwPick
 *     and the PG guard share the rule "both-HLC → compare HLC, else → compare ts",
 *     which is NON-TRANSITIVE when HLC presence is mixed and clocks are skewed —
 *     a no-HLC op between two HLC ops whose HLC order inverts their ts order forms
 *     a comparison CYCLE, so the fold winner becomes order-dependent → cross-
 *     version DIVERGENCE on a contended key. ⚠ FINDING — see findings-Y.md / EI.
 *     Bounded/transient (resolves once every peer carries an HLC, or the key stops
 *     being contended), but a real risk the all-HLC convergence proof can't see.
 *
 * PG-free, seeded (mulberry32 via the rig's `makeRng`), deterministic. Globally-
 * unique write `ts` (no fed_ts ties) so the only ordering subtlety under test is
 * the HLC-present-vs-absent fallback, not exact-tie tiebreaks.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { HlcClock, encodeHlc } from '@papercusp/locks-core';
import { stampOpHlc } from '../hlc-stamp';
import { lwwPick } from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import { FedTsGuardedStore, makeRng } from './_convergence-fuzz-rig';
import { type AdmittedLog, createMergeCursor, mergeAdmittedLogsIncremental } from '../read-merge';
import type { PeerLogOp } from '../peer-log';

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

interface GenOp {
  keyHex: string;
  op: PeerLogOp;
}

/**
 * A MIXED-version op universe. `hlcFrac` of the ops are stamped (upgraded peer);
 * the rest carry NO `hlc` (pre-314 peer). `skew` recv-advances an author's clock
 * above its own write ts (the production inversion) for the stamped ops. Write
 * `ts` is GLOBALLY strictly increasing (unique) so fed_ts is tie-free.
 */
function mixedOps(opts: {
  seed: number;
  count: number;
  keys: number;
  authors: number;
  hlcFrac: number;
  skew: boolean;
}): GenOp[] {
  const rng = makeRng(opts.seed);
  const authorPhys = new Array<number>(opts.authors).fill(1000);
  const clocks = authorPhys.map((_, i) => new HlcClock({ physical: () => authorPhys[i] }));
  let ts = 1000; // GLOBAL strictly-increasing write time → fed_ts is unique
  const out: GenOp[] = [];
  for (let i = 0; i < opts.count; i++) {
    ts += 1 + Math.floor(rng() * 40);
    const author = Math.floor(rng() * opts.authors);
    authorPhys[author] = ts;
    if (opts.skew && rng() < 0.5) {
      // recv-advance this author's clock ABOVE its write ts (the inversion the
      // D-001 fix orders correctly) — only affects the stamped ops below.
      clocks[author].recv({ ms: ts + 100 + Math.floor(rng() * 8000), count: 0 });
    }
    const base: PeerLogOp = {
      type: rng() < 0.12 ? 'del' : 'put',
      table: 'features-by-id',
      hbKey: `K-${Math.floor(rng() * opts.keys)}`,
      value: { marker: `op${i}`, author, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${author}`,
    };
    // Upgraded peer → stamp an HLC; pre-314 peer → leave `hlc` undefined.
    out.push({ keyHex: `log-${i}`, op: opts.hlcFrac > 0 && rng() < opts.hlcFrac ? stampOpHlc(base, clocks[author]) : base });
  }
  return out;
}

async function foldDigest(ops: GenOp[], orderSeed: number): Promise<string> {
  const store = new FedTsGuardedStore('fed_hlc'); // the SHIPPED production guard
  const cursor = createMergeCursor();
  const logs = shuffle(ops, makeRng(orderSeed >>> 0)).map((g) => singleOpLog(g.keyHex, g.op));
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
  return store.digest();
}

const HLC_FRACTIONS = [0, 0.3, 0.5, 0.7, 1.0]; // all-old → rolling → all-new

describe('Y/AC6 mixed-HLC back-compat — pre-314 (no-HLC) ↔ post-314 (HLC) peers CONVERGE', () => {
  it('MONOTONE regime: every rolling-upgrade mix converges (two orders → identical state)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom(...HLC_FRACTIONS), async (seed, hlcFrac) => {
        const ops = mixedOps({ seed, count: 50, keys: 6, authors: 4, hlcFrac, skew: false });
        const a = await foldDigest(ops, seed ^ 0x01);
        const b = await foldDigest(ops, seed ^ 0xbeef);
        expect(b).toBe(a);
      }),
      { numRuns: 70, seed: 0x7a },
    );
  });

  // ── EI-1698 FIXED (su-dc9db landed the synth-HLC total-order fix this lane
  // proved + recommended, projection.ts lwwPick): every op now compares by ONE
  // HLC-space key — its HLC when present, else a DERIVED encodeHlc({ms: ts,
  // count: 0}) — so the comparator is a single TOTAL ORDER and is TRANSITIVE
  // under mixed HLC. The former X/Y/Z winner CYCLE (X>Z on HLC, Z>Y on ts, Y>X on
  // ts — the per-basis "HLC-else-ts" rule was non-transitive) is gone: X>Z>Y is
  // now strict and the fold converges regardless of delivery order. This was the
  // original NON-TRANSITIVITY repro; flipped to PIN the fix (it goes RED if the
  // per-basis rule ever returns). Guard-level reachability: see the next test.
  it('EI-1698 FIXED: lwwPick is TRANSITIVE under mixed HLC + skew — the former X/Y/Z cycle resolves consistently both orders', () => {
    const mk = (id: string, hlc: string | undefined, ts: number): OpEnvelope =>
      ({ type: 'put', table: 'features-by-id', hbKey: 'K', value: { id }, ts, hlc, schema_version: 1, author_pubkey: `pk-${id}`, sourceLogKeyHex: id } as unknown as OpEnvelope);
    const X = mk('X', encodeHlc({ ms: 9_000_000, count: 0 }), 100); // upgraded peer: HLC high, ts low
    const Y = mk('Y', undefined, 150); // pre-314 peer: NO hlc → derives encodeHlc(ts=150)
    const Z = mk('Z', encodeHlc({ ms: 1_000_000, count: 0 }), 200); // upgraded peer: HLC low, ts high
    // Post-fix every op compares by one HLC-space key (no-HLC → encode(ts)), so
    // X > Z > Y is a strict TOTAL ORDER (no cycle):
    expect(lwwPick(X, Y)).toBe(X); // enc(9_000_000) > Y's derived enc(150)
    expect(lwwPick(Y, Z)).toBe(Z); // enc(1_000_000) > Y's derived enc(150)
    expect(lwwPick(X, Z)).toBe(X); // enc(9_000_000) > enc(1_000_000)
    // Transitive ⇒ the reduce-fold winner is ORDER-INDEPENDENT (convergence):
    const foldWinner = (ops: OpEnvelope[]) => ops.reduce((w, o) => lwwPick(w, o));
    expect((foldWinner([X, Y, Z]).value as { id: string }).id).toBe('X');
    expect((foldWinner([Z, Y, X]).value as { id: string }).id).toBe('X'); // same winner both orders
  });

  it('CHARACTERISATION: the non-transitivity is reachable end-to-end by the REAL merge under skew+mixed (≥1 diverging seed)', async () => {
    let diverged = 0;
    let example = -1;
    for (let seed = 1; seed <= 150 && diverged === 0; seed++) {
      const ops = mixedOps({ seed, count: 50, keys: 6, authors: 4, hlcFrac: 0.3, skew: true });
      const a = await foldDigest(ops, seed ^ 0x02);
      const b = await foldDigest(ops, seed ^ 0xf00d);
      if (a !== b) {
        diverged++;
        example = seed;
      }
    }
    expect(diverged).toBeGreaterThan(0); // teeth: the cycle is reachable through the real merge+guard
    expect(example).toBeGreaterThan(0);
  });

  it('cross-version pair: an upgraded HLC write and a pre-314 no-HLC write on the SAME key resolve order-independently', async () => {
    // The exact mixed pair the fallback governs: one op has hlc, the other does
    // not → both lwwPick and the guard MUST fall back to fed_ts identically.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const rng = makeRng(seed);
        const clock = new HlcClock({ physical: () => 1000 });
        const KEY = 'K-0';
        // op N: upgraded peer, stamped; op O: pre-314, no hlc. Distinct ts.
        const tsN = 1000 + Math.floor(rng() * 1000);
        const tsO = 2000 + Math.floor(rng() * 1000);
        const N: GenOp = {
          keyHex: 'log-N',
          op: stampOpHlc({ type: 'put', table: 'features-by-id', hbKey: KEY, value: { who: 'new', ts: tsN }, ts: tsN, schema_version: 1, author_pubkey: 'pk-n' }, clock),
        };
        const O: GenOp = {
          keyHex: 'log-O',
          op: { type: 'put', table: 'features-by-id', hbKey: KEY, value: { who: 'old', ts: tsO }, ts: tsO, schema_version: 1, author_pubkey: 'pk-o' },
        };
        const fwd = await foldDigest([N, O], seed ^ 0x11);
        const rev = await foldDigest([O, N], seed ^ 0x22);
        expect(rev).toBe(fwd); // same winner regardless of delivery order
      }),
      { numRuns: 80, seed: 0x7c },
    );
  });
});
