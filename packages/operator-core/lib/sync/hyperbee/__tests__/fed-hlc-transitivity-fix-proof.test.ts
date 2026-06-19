/**
 * fed-hlc-transitivity-fix-proof.test.ts — the PROOF-OF-FIX for EI-1698 (found
 * in version-skew-mixed-hlc-backcompat.test.ts / Brief Y).
 *
 * EI-1698: the federation LWW rule used by `lwwPick` AND the PG `fed_hlc` guard —
 * "if BOTH ops carry an HLC → compare HLC, ELSE → compare ts" — is NON-TRANSITIVE
 * under mixed HLC presence (a no-HLC op between two HLC ops whose HLC order
 * inverts their ts order forms a comparison cycle), so the fold winner becomes
 * delivery-order-dependent → a latent rolling-upgrade divergence.
 *
 * The PROPOSED FIX (EI-1698): compare in a SINGLE order space — synthesize an HLC
 * from `ts` for a no-HLC op at compare time (`missing hlc → encodeHlc({ms: ts,
 * count: 0})`), so EVERY comparison is HLC-space → one total order → transitive →
 * order-independent. This file PROVES the fix works WITHOUT touching the
 * load-bearing `lwwPick` (it models both the current rule and the fix locally,
 * so whoever lands the fix has a verified target). Pure, seeded, PG-free.
 *
 * If/when the fix lands in `lwwPick` + the guard, this file's `fixedPick` should
 * be replaced by importing the real comparator and the proof still holds.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { encodeHlc } from '@papercusp/locks-core';

interface Op {
  id: string;
  hlc?: string; // absent = pre-314 / no-HLC peer
  ts: number;
  type?: 'put' | 'del';
}

// ── the CURRENT rule (the EI-1698 defect): mode-switch HLC vs ts ──────────────
function brokenPick(a: Op, b: Op): Op {
  if (a.hlc && b.hlc) {
    if (a.hlc !== b.hlc) return a.hlc > b.hlc ? a : b;
  } else {
    const ta = a.ts ?? 0;
    const tb = b.ts ?? 0;
    if (ta !== tb) return ta > tb ? a : b;
  }
  return a.id >= b.id ? a : b; // deterministic tiebreak (mirrors sourceLogKeyHex)
}

// ── the PROPOSED FIX: one order space (synthesize HLC from ts for no-HLC) ──────
function synthHlc(op: Op): string {
  return op.hlc ?? encodeHlc({ ms: op.ts ?? 0, count: 0 });
}
function fixedPick(a: Op, b: Op): Op {
  const ha = synthHlc(a);
  const hb = synthHlc(b);
  if (ha !== hb) return ha > hb ? a : b;
  return a.id >= b.id ? a : b;
}

/** Win-count signature of a triple under a comparator: a STRICT TOTAL ORDER
 *  yields wins {0,1,2}; a 3-CYCLE yields {1,1,1}. */
function winCounts(pick: (a: Op, b: Op) => Op, ops: [Op, Op, Op]): number[] {
  const wins = new Map<string, number>(ops.map((o) => [o.id, 0]));
  const pairs: [Op, Op][] = [
    [ops[0], ops[1]],
    [ops[0], ops[2]],
    [ops[1], ops[2]],
  ];
  for (const [x, y] of pairs) {
    const w = pick(x, y);
    wins.set(w.id, (wins.get(w.id) ?? 0) + 1);
  }
  return [...wins.values()].sort((a, b) => a - b);
}

describe('EI-1698 proof-of-fix — synthesize-HLC-from-ts restores a transitive total order', () => {
  // The canonical counterexample from the finding (X HLC-high/ts-low, Y no-HLC
  // ts-mid, Z HLC-low/ts-high).
  const X: Op = { id: 'X', hlc: encodeHlc({ ms: 9_000_000, count: 0 }), ts: 100 };
  const Y: Op = { id: 'Y', ts: 150 }; // no HLC
  const Z: Op = { id: 'Z', hlc: encodeHlc({ ms: 1_000_000, count: 0 }), ts: 200 };

  it('the CURRENT rule cycles on X/Y/Z (reconfirms EI-1698)', () => {
    expect(winCounts(brokenPick, [X, Y, Z])).toEqual([1, 1, 1]); // {1,1,1} == a 3-cycle
  });

  it('the FIX makes X/Y/Z a strict total order (acyclic)', () => {
    expect(winCounts(fixedPick, [X, Y, Z])).toEqual([0, 1, 2]); // total order
    // and the reduce-fold winner is now order-INDEPENDENT:
    const fold = (ops: Op[]) => ops.reduce((w, o) => fixedPick(w, o));
    expect(fold([X, Y, Z]).id).toBe(fold([Z, Y, X]).id);
  });

  it('PROPERTY: the fix is transitive for ANY mixed-HLC triple; the current rule is not (teeth)', () => {
    // Generate mixed ops: hlc.ms INDEPENDENT of ts (the skew that decouples HLC
    // from ts order) and randomly absent (the pre-314 peer). Distinct ids.
    const arbOp = (tag: string) =>
      fc
        .record({
          hasHlc: fc.boolean(),
          hlcMs: fc.integer({ min: 0, max: 10_000_000 }),
          ts: fc.integer({ min: 0, max: 10_000_000 }),
        })
        .map((r): Op => ({
          id: tag,
          hlc: r.hasHlc ? encodeHlc({ ms: r.hlcMs, count: 0 }) : undefined,
          ts: r.ts,
        }));

    let brokenCycles = 0;
    fc.assert(
      fc.property(arbOp('a'), arbOp('b'), arbOp('c'), (a, b, c) => {
        // FIX: never a cycle — always a strict total order ({0,1,2}).
        expect(winCounts(fixedPick, [a, b, c])).toEqual([0, 1, 2]);
        // CURRENT: count how often it cycles (proves the teeth are real).
        if (winCounts(brokenPick, [a, b, c]).every((n) => n === 1)) brokenCycles++;
      }),
      { numRuns: 600, seed: 0x1698 },
    );
    expect(brokenCycles).toBeGreaterThan(0); // the current rule DOES cycle in the sweep
  });

  it('FOLD CONVERGENCE: under the fix, a mixed universe yields an order-independent winner per key', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        // build a small mixed universe on one key, fold under fixedPick in two
        // shuffled orders → same winner (a total order's max is order-free).
        let a = seed >>> 0;
        const rng = () => {
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const ops: Op[] = Array.from({ length: 12 }, (_, i) => ({
          id: `op${i}`,
          hlc: rng() < 0.5 ? encodeHlc({ ms: Math.floor(rng() * 1e7), count: 0 }) : undefined,
          ts: Math.floor(rng() * 1e7),
        }));
        const shuffle = (arr: Op[]) => {
          const x = arr.slice();
          for (let i = x.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [x[i], x[j]] = [x[j], x[i]];
          }
          return x;
        };
        const w1 = shuffle(ops).reduce((w, o) => fixedPick(w, o)).id;
        const w2 = shuffle(ops).reduce((w, o) => fixedPick(w, o)).id;
        expect(w2).toBe(w1);
      }),
      { numRuns: 200, seed: 0x1698 + 1 },
    );
  });
});
