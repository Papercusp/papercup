/**
 * rate-limiter.test.ts — EN-2 (P-RATE) pure limiter teeth tests.
 *
 * Properties proven here (the brief's S0 set):
 *  - under cap ⇒ admit; over cap ⇒ drop (the core enforcement).
 *  - no policy (undefined cap) ⇒ unlimited, zero state (default behavior unchanged).
 *  - deterministic tumbling windows by op write-time (boundary correctness).
 *  - idempotent re-fold: an admitted op replayed ⇒ admit, no recount; a dropped op
 *    replayed ⇒ drop (so a cursor-reset re-fold reproduces the same drop set).
 *  - per-author + per-class isolation.
 *  - bounded memory under an unbounded flood (anti-OOM; ties Brief W/X).
 *  - convergence: per-author processing order is identical on every honest peer,
 *    so two limiters fed the same per-author order (any cross-author interleave)
 *    decide identically.
 *  - TEETH: neuter the limiter (unset cap ⇒ unlimited) and the flood all admits.
 */

import { describe, it, expect } from 'vitest';
import {
  MemberRateLimiter,
  RATE_WINDOW_MS,
  capForClass,
  type RateCaps,
  type RateClass,
} from './rate-limiter';

const OPS_W = RATE_WINDOW_MS.ops; // 60_000

/** Feed `n` ops for one author into a limiter at evenly-clustered timestamps
 *  inside ONE window (a realistic real-time flood — a client stamps truthful ts). */
function flood(
  lim: MemberRateLimiter,
  authorId: number,
  cls: RateClass,
  cap: number | undefined,
  n: number,
  baseTs = 1_000_000_000_000,
): { admit: number; drop: number } {
  let admit = 0;
  let drop = 0;
  for (let i = 0; i < n; i++) {
    const r = lim.check({ authorId, cls, opId: `${authorId}:${i}`, tsMs: baseTs + i, cap });
    if (r === 'admit' || r === 'unlimited') admit++;
    else drop++;
  }
  return { admit, drop };
}

describe('capForClass', () => {
  it('maps each class to its policy axis; unset/negative/non-finite ⇒ undefined', () => {
    const caps: RateCaps = { opsPerMin: 10, rowsPerHour: 100, prsPerDay: 5 };
    expect(capForClass(caps, 'ops')).toBe(10);
    expect(capForClass(caps, 'rows')).toBe(100);
    expect(capForClass(caps, 'prs')).toBe(5);
    expect(capForClass(null, 'ops')).toBeUndefined();
    expect(capForClass({}, 'ops')).toBeUndefined();
    expect(capForClass({ opsPerMin: -1 }, 'ops')).toBeUndefined();
    expect(capForClass({ opsPerMin: Number.NaN }, 'ops')).toBeUndefined();
    expect(capForClass({ opsPerMin: Infinity }, 'ops')).toBeUndefined();
  });
  it('treats a finite 0 as a real cap (block-all), not unset', () => {
    expect(capForClass({ opsPerMin: 0 }, 'ops')).toBe(0);
  });
});

describe('MemberRateLimiter — core enforcement', () => {
  it('admits up to cap and drops the excess within a window', () => {
    const lim = new MemberRateLimiter();
    const { admit, drop } = flood(lim, 1, 'ops', 10, 100);
    expect(admit).toBe(10);
    expect(drop).toBe(90);
  });

  it('no cap (undefined) ⇒ unlimited, and touches NO state (zero behavior change)', () => {
    const lim = new MemberRateLimiter();
    const { admit, drop } = flood(lim, 1, 'ops', undefined, 5000);
    expect(admit).toBe(5000);
    expect(drop).toBe(0);
    expect(lim.size()).toBe(0); // un-policed hive pays nothing
  });

  it('cap 0 ⇒ block all ops of the class', () => {
    const lim = new MemberRateLimiter();
    const { admit, drop } = flood(lim, 1, 'ops', 0, 20);
    expect(admit).toBe(0);
    expect(drop).toBe(20);
  });

  it('TEETH: neutered limiter (cap unset) lets the whole flood through', () => {
    // The control that goes RED if enforcement is silently a no-op: with a cap
    // set we drop 90/100; remove the cap and all 100 apply.
    const limited = new MemberRateLimiter();
    expect(flood(limited, 7, 'ops', 10, 100).drop).toBe(90);
    const neutered = new MemberRateLimiter();
    expect(flood(neutered, 7, 'ops', undefined, 100).drop).toBe(0);
  });
});

describe('MemberRateLimiter — windows', () => {
  it('resets at the next tumbling window (cap refreshes per window)', () => {
    const lim = new MemberRateLimiter();
    const base = 60_000 * 1000; // aligned to a window boundary
    // window 0: 3 ops, cap 2 ⇒ 2 admit, 1 drop
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'a', tsMs: base + 0, cap: 2 })).toBe('admit');
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'b', tsMs: base + 1, cap: 2 })).toBe('admit');
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'c', tsMs: base + 2, cap: 2 })).toBe('drop');
    // next window admits again
    expect(
      lim.check({ authorId: 1, cls: 'ops', opId: 'd', tsMs: base + OPS_W, cap: 2 }),
    ).toBe('admit');
  });

  it('no off-by-one at the window boundary (ts = k*window is the next window)', () => {
    const lim = new MemberRateLimiter();
    const base = 0;
    // Fill window 0 to cap 1 at ts just-below the boundary.
    expect(lim.check({ authorId: 2, cls: 'ops', opId: 'x', tsMs: OPS_W - 1, cap: 1 })).toBe('admit');
    expect(lim.check({ authorId: 2, cls: 'ops', opId: 'y', tsMs: OPS_W - 1, cap: 1 })).toBe('drop');
    // ts exactly at the boundary belongs to window 1 ⇒ admits.
    expect(lim.check({ authorId: 2, cls: 'ops', opId: 'z', tsMs: OPS_W, cap: 1 })).toBe('admit');
    void base;
  });
});

describe('MemberRateLimiter — idempotency (re-fold safety)', () => {
  it('replaying an ADMITTED op returns admit without consuming the cap again', () => {
    const lim = new MemberRateLimiter();
    const ts = 1_000_000;
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'a', tsMs: ts, cap: 2 })).toBe('admit');
    // replay 'a' many times — must stay admit and NOT consume budget
    for (let i = 0; i < 5; i++) {
      expect(lim.check({ authorId: 1, cls: 'ops', opId: 'a', tsMs: ts, cap: 2 })).toBe('admit');
    }
    // budget intact: two MORE distinct ops still fit (b admit, then over cap)
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'b', tsMs: ts + 1, cap: 2 })).toBe('admit');
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'c', tsMs: ts + 2, cap: 2 })).toBe('drop');
  });

  it('replaying a DROPPED op returns drop deterministically (no state growth)', () => {
    const lim = new MemberRateLimiter();
    const ts = 1_000_000;
    lim.check({ authorId: 1, cls: 'ops', opId: 'a', tsMs: ts, cap: 1 });
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'b', tsMs: ts + 1, cap: 1 })).toBe('drop');
    for (let i = 0; i < 5; i++) {
      expect(lim.check({ authorId: 1, cls: 'ops', opId: 'b', tsMs: ts + 1, cap: 1 })).toBe('drop');
    }
  });

  it('a full re-fold of the same op stream reproduces the identical decision set', () => {
    const stream = Array.from({ length: 50 }, (_, i) => ({
      authorId: 1,
      cls: 'ops' as RateClass,
      opId: `op${i}`,
      tsMs: 5_000_000 + i,
      cap: 10,
    }));
    const first = new MemberRateLimiter();
    const decisions1 = stream.map((c) => first.check(c));
    // Re-fold the SAME stream into the SAME limiter (cursor-reset replay).
    const decisions2 = stream.map((c) => first.check(c));
    expect(decisions2).toEqual(decisions1);
    // And a fresh limiter (a different honest peer) decides identically.
    const peer = new MemberRateLimiter();
    expect(stream.map((c) => peer.check(c))).toEqual(decisions1);
  });
});

describe('MemberRateLimiter — isolation', () => {
  it('per-author: one member flooding does not consume another member budget', () => {
    const lim = new MemberRateLimiter();
    flood(lim, 1, 'ops', 5, 100); // author 1 floods
    // author 2's legit ops are unaffected
    const { admit } = flood(lim, 2, 'ops', 5, 5, 2_000_000_000_000);
    expect(admit).toBe(5);
  });

  it('per-class: ops and rows are counted independently', () => {
    const lim = new MemberRateLimiter();
    const base = 9_000_000;
    // exhaust ops cap (2)
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'o1', tsMs: base, cap: 2 })).toBe('admit');
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'o2', tsMs: base, cap: 2 })).toBe('admit');
    expect(lim.check({ authorId: 1, cls: 'ops', opId: 'o3', tsMs: base, cap: 2 })).toBe('drop');
    // rows cap is separate and still open
    expect(lim.check({ authorId: 1, cls: 'rows', opId: 'r1', tsMs: base, cap: 2 })).toBe('admit');
  });
});

describe('MemberRateLimiter — convergence across honest peers', () => {
  it('two peers with the same per-author order (any cross-author interleave) decide identically', () => {
    // Build per-author op sequences (each author has a stable log order).
    const a = Array.from({ length: 20 }, (_, i) => ({ authorId: 1, opId: `a${i}`, tsMs: 7_000_000 + i }));
    const b = Array.from({ length: 20 }, (_, i) => ({ authorId: 2, opId: `b${i}`, tsMs: 7_000_000 + i }));

    // Peer 1 interleaves A then B; peer 2 interleaves round-robin. Per-author
    // order is preserved on both (the only thing honest peers guarantee).
    const peer1 = new MemberRateLimiter();
    const dec1 = new Map<string, string>();
    for (const op of [...a, ...b]) {
      dec1.set(op.opId, peer1.check({ authorId: op.authorId, cls: 'ops', opId: op.opId, tsMs: op.tsMs, cap: 5 }));
    }
    const peer2 = new MemberRateLimiter();
    const dec2 = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      for (const op of [a[i], b[i]]) {
        dec2.set(op.opId, peer2.check({ authorId: op.authorId, cls: 'ops', opId: op.opId, tsMs: op.tsMs, cap: 5 }));
      }
    }
    expect(dec2).toEqual(dec1);
    // and exactly cap per author admitted
    const admittedA = [...dec1].filter(([k, v]) => k.startsWith('a') && v === 'admit').length;
    expect(admittedA).toBe(5);
  });
});

describe('MemberRateLimiter — bounded memory under flood (anti-OOM)', () => {
  it('an unbounded same-window flood keeps per-(author,class) state ~O(cap)', () => {
    const lim = new MemberRateLimiter();
    const cap = 10;
    flood(lim, 1, 'ops', cap, 100_000); // 100k-op flood, clustered ts
    // Only one (author,class) tracked.
    expect(lim.size()).toBe(1);
    // Snapshot shows the window pinned at cap (not 100k).
    const snap = lim.snapshot({ opsPerMin: cap });
    expect(snap).toHaveLength(1);
    expect(snap[0].count).toBe(cap);
    expect(snap[0].cap).toBe(cap);
  });

  it('a forged-ts ramp keeps STATE bounded (anti-OOM): clamp + prune cap live windows', () => {
    // A malicious client forges each op ts wildly far ahead to try to (a) evade
    // the cap and (b) explode memory with one bucket per fake window. The ±1-window
    // clamp + retention pruning bound the LIVE window state regardless of how far
    // the ts is forged — so the flood cannot OOM an honest peer (ties Brief W/X).
    const lim = new MemberRateLimiter({ retentionWindows: 3 });
    const base = 1_000_000;
    for (let i = 0; i < 100_000; i++) {
      lim.check({ authorId: 1, cls: 'ops', opId: `j${i}`, tsMs: base + i * 10 * OPS_W, cap: 2 });
    }
    expect(lim.size()).toBe(1); // one (author,class)
    // Live buckets bounded by retention+1, NOT the 100k forged windows.
    expect(lim.windowCount()).toBeLessThanOrEqual(4);
  });

  it('DOCUMENTED RESIDUAL: forging ts across windows evades the per-window cap (Brief X depth)', () => {
    // Honest trust-model statement, asserted as a known limitation: the limiter is
    // deterministic over the op-INTRINSIC ts (required for cross-peer convergence),
    // so it cannot distinguish "100 ops genuinely 1 window apart" from "100 ops in a
    // real-time burst with forged spread-out ts". A truthful flood is fully caught
    // (clustered ts ⇒ one window ⇒ cap trips); a client RECOMPILED to forge ts can
    // pace under the per-window cap. The mitigation (a non-convergent receiver-clock
    // burst guard) is a documented fast-follow — see findings-EN-2.md trust model.
    const cap = 2;
    // truthful real-time flood: all ts in one window ⇒ only `cap` admit.
    const truthful = new MemberRateLimiter();
    const truthfulAdmit = flood(truthful, 1, 'ops', cap, 100).admit;
    expect(truthfulAdmit).toBe(cap);
    // forged-ts flood: one op per window ⇒ more than `cap` slip through.
    const forged = new MemberRateLimiter();
    let forgedAdmit = 0;
    for (let i = 0; i < 100; i++) {
      const r = forged.check({ authorId: 1, cls: 'ops', opId: `f${i}`, tsMs: 1_000_000 + i * OPS_W, cap });
      if (r === 'admit') forgedAdmit++;
    }
    expect(forgedAdmit).toBeGreaterThan(truthfulAdmit); // the residual, made explicit
  });
});

describe('MemberRateLimiter — snapshot (observability)', () => {
  it('reports current-window count vs cap per tracked member', () => {
    const lim = new MemberRateLimiter();
    const caps: RateCaps = { opsPerMin: 5, rowsPerHour: 50 };
    flood(lim, 42, 'ops', 5, 8); // 5 admit, 3 drop
    const snap = lim.snapshot(caps);
    const row = snap.find((r) => r.authorId === 42 && r.cls === 'ops');
    expect(row).toBeDefined();
    expect(row!.count).toBe(5);
    expect(row!.cap).toBe(5);
    expect(row!.throttled).toBe(true); // at cap ⇒ visibly throttled
    expect(row!.windowMs).toBe(OPS_W);
  });

  it('throttled is false for a member under cap', () => {
    const lim = new MemberRateLimiter();
    flood(lim, 1, 'ops', 10, 3); // 3 of 10
    const row = lim.snapshot({ opsPerMin: 10 }).find((r) => r.authorId === 1);
    expect(row!.count).toBe(3);
    expect(row!.throttled).toBe(false);
  });
});

/** Ramp `n` ops for one author across CONSECUTIVE windows by stamping each op one
 *  window further into the future — the forged-`ts` evasion pattern (1 op/window
 *  slips under any per-window cap while driving the author's hwm forward). Returns
 *  the admit/drop tally (each ramp op is alone in its window ⇒ admits for cap ≥ 1). */
function ramp(
  lim: MemberRateLimiter,
  authorId: number,
  cls: RateClass,
  cap: number | undefined,
  n: number,
  baseTs = 1_000_000_000_000,
): { admit: number; drop: number } {
  let admit = 0;
  let drop = 0;
  for (let i = 0; i < n; i++) {
    const r = lim.check({ authorId, cls, opId: `${authorId}:r${i}`, tsMs: baseTs + i * RATE_WINDOW_MS[cls], cap });
    if (r === 'admit' || r === 'unlimited') admit++;
    else drop++;
  }
  return { admit, drop };
}

describe('MemberRateLimiter — forged-op-time detection (WI-268)', () => {
  const BASE = 1_700_000_000_000;

  it('flags an author whose op-ts ramp far ahead of the honest population', () => {
    const lim = new MemberRateLimiter(); // default skewThresholdWindows = 5
    flood(lim, 1, 'ops', 10, 3, BASE); // honest author, clustered in one window
    const forge = ramp(lim, 2, 'ops', 10, 10, BASE); // ramps 10 windows ahead, 1/window
    expect(forge.admit).toBe(10); // the evasion: every ramp op slips under the per-window cap
    const snap = lim.snapshot({ opsPerMin: 10 });
    const honest = snap.find((r) => r.authorId === 1 && r.cls === 'ops')!;
    const forger = snap.find((r) => r.authorId === 2 && r.cls === 'ops')!;
    expect(forger.skewWindows).toBeGreaterThan(5);
    expect(forger.suspectedTimestampSkew).toBe(true);
    expect(honest.suspectedTimestampSkew).toBe(false); // the honest baseline is never flagged
    expect(honest.skewWindows).toBe(0);
  });

  it('does NOT flag a truthful clustered flood (over cap ⇒ throttled, but not skewed)', () => {
    const lim = new MemberRateLimiter();
    flood(lim, 1, 'ops', 5, 3, BASE); // honest baseline
    flood(lim, 2, 'ops', 5, 40, BASE); // a real-time burst: 40 ops, all in ONE window
    const row = lim.snapshot({ opsPerMin: 5 }).find((r) => r.authorId === 2)!;
    expect(row.throttled).toBe(true); // it IS over cap (caught by the convergent drop)
    expect(row.suspectedTimestampSkew).toBe(false); // …but its ts are truthful ⇒ no skew flag
    expect(row.skewWindows).toBe(0);
  });

  it('a single stray far-future op cannot trip the flag (the ±1-window clamp)', () => {
    const lim = new MemberRateLimiter();
    flood(lim, 1, 'ops', 10, 3, BASE); // honest baseline
    // Author 2: one normal op, then one op stamped 100 windows into the future.
    lim.check({ authorId: 2, cls: 'ops', opId: '2:a', tsMs: BASE, cap: 10 });
    lim.check({ authorId: 2, cls: 'ops', opId: '2:far', tsMs: BASE + 100 * OPS_W, cap: 10 });
    const row = lim.snapshot({ opsPerMin: 10 }).find((r) => r.authorId === 2)!;
    expect(row.skewWindows).toBeLessThanOrEqual(1); // clamp let hwm advance only one window
    expect(row.suspectedTimestampSkew).toBe(false);
  });

  it('does NOT flag a lone author (no honest baseline to compare against)', () => {
    const lim = new MemberRateLimiter();
    ramp(lim, 7, 'ops', 10, 20, BASE); // 20 windows ahead — but the ONLY author
    const row = lim.snapshot({ opsPerMin: 10 }).find((r) => r.authorId === 7)!;
    expect(row.skewWindows).toBe(0);
    expect(row.suspectedTimestampSkew).toBe(false);
  });

  it('does NOT flag honest authors clustered at the frontier (no false positive)', () => {
    const lim = new MemberRateLimiter();
    // Three honest authors, ts within the same window (normal inter-member jitter).
    for (const a of [1, 2, 3]) flood(lim, a, 'ops', 10, 4, BASE + a * 1_000);
    const snap = lim.snapshot({ opsPerMin: 10 }).filter((r) => r.cls === 'ops');
    expect(snap.every((r) => !r.suspectedTimestampSkew)).toBe(true);
    expect(snap.every((r) => r.skewWindows <= 1)).toBe(true);
  });

  it('skew flag is convergent: two peers, any cross-author interleave, identical snapshot', () => {
    const mk = () => new MemberRateLimiter();
    const peerA = mk();
    const peerB = mk();
    // peerA: honest author fully, then the forger's ramp.
    flood(peerA, 1, 'ops', 10, 3, BASE);
    ramp(peerA, 2, 'ops', 10, 9, BASE);
    // peerB: the SAME two per-author streams, but interleaved the other way.
    ramp(peerB, 2, 'ops', 10, 9, BASE);
    flood(peerB, 1, 'ops', 10, 3, BASE);
    const norm = (lim: MemberRateLimiter) =>
      lim
        .snapshot({ opsPerMin: 10 })
        .map((r) => ({ a: r.authorId, c: r.cls, skew: r.skewWindows, flag: r.suspectedTimestampSkew }))
        .sort((x, y) => x.a - y.a);
    expect(norm(peerA)).toEqual(norm(peerB));
    expect(norm(peerA).find((r) => r.a === 2)!.flag).toBe(true);
  });

  it('respects a custom skewThresholdWindows', () => {
    const strict = new MemberRateLimiter({ skewThresholdWindows: 2 });
    flood(strict, 1, 'ops', 10, 2, BASE);
    ramp(strict, 2, 'ops', 10, 4, BASE); // 4 windows ahead > 2 ⇒ flagged under strict
    const row = strict.snapshot({ opsPerMin: 10 }).find((r) => r.authorId === 2)!;
    expect(row.skewWindows).toBeGreaterThan(2);
    expect(row.suspectedTimestampSkew).toBe(true);
  });
});

describe('MemberRateLimiter — decide (atomic multi-class)', () => {
  it('drops the op if ANY class is over cap, and spends no budget on a drop', () => {
    const lim = new MemberRateLimiter();
    const ts = 3_000_000;
    // ops cap 1 (tight), rows cap 5 (loose). First op admits (ops=1, rows=1).
    expect(lim.decide(1, 'a', ts, [{ cls: 'ops', cap: 1 }, { cls: 'rows', cap: 5 }])).toBe('admit');
    // Second op trips ops ⇒ drop; must NOT consume a rows slot.
    expect(lim.decide(1, 'b', ts + 1, [{ cls: 'ops', cap: 1 }, { cls: 'rows', cap: 5 }])).toBe('drop');
    // rows budget intact: 4 more rows-only ops still fit (rows cap 5, 1 used).
    for (let i = 0; i < 4; i++) {
      expect(lim.decide(1, `r${i}`, ts + 2 + i, [{ cls: 'rows', cap: 5 }])).toBe('admit');
    }
    expect(lim.decide(1, 'r-over', ts + 99, [{ cls: 'rows', cap: 5 }])).toBe('drop');
  });

  it('all-undefined caps ⇒ unlimited, no state', () => {
    const lim = new MemberRateLimiter();
    expect(lim.decide(1, 'a', 1000, [{ cls: 'ops', cap: undefined }])).toBe('unlimited');
    expect(lim.size()).toBe(0);
  });
});
