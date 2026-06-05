/**
 * crdt — CRDT primitive unit tests (D-004,
 * locks-correctness-hardening-2026-06-04). Covers the convergence laws
 * (commutative/associative/idempotent merge) and the concurrent-update cases
 * naive last-write-wins silently loses.
 */

import { describe, it, expect } from 'vitest';
import {
  vvCompare,
  vvMerge,
  vvIncrement,
  vvSeen,
  dvvNew,
  dvvDescends,
  dvvConcurrent,
  gCounterValue,
  gCounterInc,
  gCounterMerge,
  pnZero,
  pnValue,
  pnInc,
  pnDec,
  pnMerge,
  orSetEmpty,
  orSetAdd,
  orSetRemove,
  orSetValues,
  orSetHas,
  orSetMerge,
  lwwSet,
  lwwMerge,
  decideMerge,
  type PnCounter,
  type OrSet,
} from './crdt';

describe('version vectors', () => {
  it('compares causal order', () => {
    expect(vvCompare({ a: 1 }, { a: 1 })).toBe('equal');
    expect(vvCompare({ a: 2, b: 1 }, { a: 1, b: 1 })).toBe('dominates');
    expect(vvCompare({ a: 1, b: 1 }, { a: 2, b: 1 })).toBe('dominated');
    expect(vvCompare({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe('concurrent');
    expect(vvCompare({}, { a: 1 })).toBe('dominated');
  });

  it('merges (pointwise max), increments, and answers seen()', () => {
    expect(vvMerge({ a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
    expect(vvIncrement({ a: 1 }, 'a')).toEqual({ a: 2 });
    expect(vvIncrement({ a: 1 }, 'b')).toEqual({ a: 1, b: 1 });
    expect(vvSeen({ a: 3 }, 'a', 3)).toBe(true);
    expect(vvSeen({ a: 3 }, 'a', 4)).toBe(false);
  });
});

describe('dotted version vectors', () => {
  it('a fresh dot extends the context by one and is concurrent with a sibling', () => {
    const ctx = { a: 1, b: 2 };
    const da = dvvNew(ctx, 'a'); // dot a:2
    expect(da.dot).toEqual({ actor: 'a', counter: 2 });

    // Two writes off the SAME context by different actors are concurrent.
    const db = dvvNew(ctx, 'b'); // dot b:3
    expect(dvvConcurrent(da, db)).toBe(true);

    // A later write whose context absorbed da's dot descends from it.
    const dLater = dvvNew(vvMerge(ctx, { a: 2 }), 'c');
    expect(dvvDescends(dLater, da)).toBe(true);
    expect(dvvConcurrent(dLater, da)).toBe(false);
  });
});

describe('PN-Counter (tallies / spend)', () => {
  it('concurrent increments from different actors all survive (naive LWW would lose one)', () => {
    // Two replicas each +1 "at the same time" from a shared base.
    const base = pnInc(pnZero(), 'seed', 5); // value 5
    const ra = pnInc(base, 'a', 1); // replica A: +1
    const rb = pnInc(base, 'b', 1); // replica B: +1
    const merged = pnMerge(ra, rb);
    expect(pnValue(merged)).toBe(7); // 5 + 1 + 1 — NOT 6 (no lost update)
  });

  it('supports decrements and merge is commutative + idempotent', () => {
    const a = pnDec(pnInc(pnZero(), 'a', 10), 'a', 3); // 7
    const b = pnInc(pnZero(), 'b', 4); // 4
    expect(pnValue(pnMerge(a, b))).toBe(11);
    // commutative
    expect(pnMerge(a, b)).toEqual(pnMerge(b, a));
    // idempotent
    expect(pnMerge(pnMerge(a, b), b)).toEqual(pnMerge(a, b));
  });

  it('gCounter rejects negative increments', () => {
    expect(() => gCounterInc({}, 'a', -1)).toThrow();
    expect(gCounterValue(gCounterMerge({ a: 3 }, { a: 1, b: 2 }))).toBe(5);
  });
});

describe('OR-Set (add-wins)', () => {
  it('add-wins: a concurrent add beats a concurrent remove', () => {
    // base has element "x" with tag t0.
    let base: OrSet = orSetAdd(orSetEmpty(), 'x', 't0');
    // Replica A removes x (observes t0). Replica B concurrently re-adds x (new tag t1).
    const ra = orSetRemove(base, 'x');
    const rb = orSetAdd(base, 'x', 't1');
    const merged = orSetMerge(ra, rb);
    // t0 is tombstoned, but t1 (the concurrent add) survives → x present.
    expect(orSetHas(merged, 'x')).toBe(true);
    expect(orSetValues(merged)).toEqual(['x']);
  });

  it('a remove that observed all tags wins when there is no concurrent add', () => {
    let s: OrSet = orSetAdd(orSetAdd(orSetEmpty(), 'y', 'a:1'), 'y', 'a:2');
    s = orSetRemove(s, 'y');
    expect(orSetHas(s, 'y')).toBe(false);
    expect(orSetValues(s)).toEqual([]);
  });

  it('merge is commutative, associative and idempotent', () => {
    const a = orSetAdd(orSetEmpty(), 'a', 't1');
    const b = orSetRemove(orSetAdd(orSetEmpty(), 'a', 't1'), 'a');
    const c = orSetAdd(orSetEmpty(), 'b', 't2');
    expect(orSetMerge(a, b)).toEqual(orSetMerge(b, a));
    expect(orSetMerge(orSetMerge(a, b), c)).toEqual(orSetMerge(a, orSetMerge(b, c)));
    expect(orSetMerge(orSetMerge(a, c), c)).toEqual(orSetMerge(a, c));
  });
});

describe('LWW-Register (HLC-keyed, per-field)', () => {
  it('keeps the greater HLC; breaks an exact-HLC tie by actor', () => {
    const a = lwwSet('A', { ms: 1000, count: 0 }, 'peer-a');
    const b = lwwSet('B', { ms: 2000, count: 0 }, 'peer-b');
    expect(lwwMerge(a, b).value).toBe('B'); // later HLC
    expect(lwwMerge(b, a).value).toBe('B'); // order-independent

    const tieA = lwwSet('A', { ms: 5, count: 1 }, 'peer-a');
    const tieB = lwwSet('B', { ms: 5, count: 1 }, 'peer-b');
    expect(lwwMerge(tieA, tieB).value).toBe('B'); // greater actor wins the tie
    expect(lwwMerge(tieB, tieA).value).toBe('B');
  });
});

describe('decideMerge (Thomas Write Rule + conflict routing)', () => {
  it('applies a causally-later write, drops a stale one, escalates a concurrent one', () => {
    const local = { a: 2, b: 1 };
    expect(decideMerge(local, { a: 3, b: 1 }).kind).toBe('apply'); // incoming dominates
    expect(decideMerge(local, { a: 1, b: 1 }).kind).toBe('drop'); // incoming dominated (re-upsert)
    expect(decideMerge(local, { a: 2, b: 1 }).kind).toBe('drop'); // equal (duplicate)
    expect(decideMerge(local, { a: 1, b: 2 }).kind).toBe('conflict'); // concurrent → resolver
  });
});
