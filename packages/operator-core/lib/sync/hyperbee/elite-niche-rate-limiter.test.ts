/**
 * elite-niche-rate-limiter.test.ts — F1-6 / P-014 (federated-scout-gym): the
 * per-(source-author, niche) deterministic windowed elite decider. Verifies the
 * same convergence contract MemberRateLimiter carries: admit-first-cap per
 * (author,niche,window), idempotent re-fold, per-key isolation, tumbling op-ts
 * windows, the anti-evasion clamp's O(1)-state bound, and default-off.
 */
import { describe, it, expect } from 'vitest';
import { EliteNicheRateLimiter } from './elite-niche-rate-limiter';
import { RATE_WINDOW_MS } from './rate-limiter';

const HOUR = RATE_WINDOW_MS.rows; // 3_600_000 — the default window
const A = 1001;
const B = 2002;
const N1 = 'v1:loop/guard/r2/size-m';
const N2 = 'v1:ui/panel/r1/size-s';

describe('EliteNicheRateLimiter', () => {
  it('admits the first `cap` ops per (author,niche,window), drops the rest', () => {
    const rl = new EliteNicheRateLimiter();
    const ts = 1_000_000; // window 0
    let admits = 0;
    for (let i = 0; i < 7; i++) if (rl.decide(A, N1, `op${i}`, ts + i, 3) === 'admit') admits++;
    expect(admits).toBe(3);
  });

  it('default-off: an undefined cap ⇒ unlimited, touching no state', () => {
    const rl = new EliteNicheRateLimiter();
    for (let i = 0; i < 100; i++) {
      expect(rl.decide(A, N1, `op${i}`, 1_000_000 + i, undefined)).toBe('unlimited');
    }
    expect(rl.size()).toBe(0);
  });

  it('a block-all cap (0) drops every op', () => {
    const rl = new EliteNicheRateLimiter();
    expect(rl.decide(A, N1, 'op1', 1_000_000, 0)).toBe('drop');
    expect(rl.decide(A, N1, 'op2', 1_000_001, 0)).toBe('drop');
  });

  it('replay of an admitted opId re-admits without recounting (idempotent re-fold)', () => {
    const rl = new EliteNicheRateLimiter();
    expect(rl.decide(A, N1, 'op1', 1_000_000, 1)).toBe('admit');
    // Replay op1 ⇒ admit again, budget NOT re-spent.
    expect(rl.decide(A, N1, 'op1', 1_000_000, 1)).toBe('admit');
    // A genuinely-new op in the same window ⇒ drop (cap already reached by op1).
    expect(rl.decide(A, N1, 'op2', 1_000_000, 1)).toBe('drop');
  });

  it('each (author,niche) is an independent budget', () => {
    const rl = new EliteNicheRateLimiter();
    const ts = 1_000_000;
    expect(rl.decide(A, N1, 'a1', ts, 1)).toBe('admit');
    expect(rl.decide(A, N1, 'a2', ts + 1, 1)).toBe('drop'); // A/N1 exhausted
    expect(rl.decide(A, N2, 'b1', ts, 1)).toBe('admit'); // fresh niche
    expect(rl.decide(B, N1, 'c1', ts, 1)).toBe('admit'); // fresh author
  });

  it('a new tumbling window resets the budget', () => {
    const rl = new EliteNicheRateLimiter();
    expect(rl.decide(A, N1, 'w0', 1_000_000, 1)).toBe('admit'); // window 0
    expect(rl.decide(A, N1, 'w0b', 1_000_001, 1)).toBe('drop'); // same window
    expect(rl.decide(A, N1, 'w1', 1_000_000 + HOUR, 1)).toBe('admit'); // next window
  });

  it('malformed attribution or empty niche ⇒ admit (the caller owns the fail-closed drop)', () => {
    const rl = new EliteNicheRateLimiter();
    expect(rl.decide(Number.NaN, N1, 'x', 1_000_000, 1)).toBe('admit');
    expect(rl.decide(A, N1, 'x', Number.NaN, 1)).toBe('admit');
    expect(rl.decide(A, '', 'x', 1_000_000, 1)).toBe('admit');
  });

  it('anti-evasion clamp: a forged far-future ts cannot grow state unboundedly', () => {
    const rl = new EliteNicheRateLimiter();
    rl.decide(A, N1, 'base', 1_000_000, 1); // establishes hwm near window 0
    // A burst of forged far-future ops (distinct ids). The clamp bounds each op's
    // ts into one window of the hwm, so hwm advances by ≤ 1 window/op — no op leaps
    // hundreds of windows ahead, and pruning keeps the live-window set tiny.
    for (let i = 0; i < 50; i++) rl.decide(A, N1, `f${i}`, 9_999_999_999, 1);
    expect(rl.size()).toBe(1); // one (author,niche) key
    expect(rl.windowCount()).toBeLessThanOrEqual(4); // ≤ retentionWindows(3)+1
  });

  it('a same-window burst is capped even when ts is forged far into the future', () => {
    const rl = new EliteNicheRateLimiter();
    // All ops share ONE forged ts ⇒ one window ⇒ the per-window cap applies.
    let admits = 0;
    for (let i = 0; i < 10; i++) if (rl.decide(A, N1, `s${i}`, 5_000_000_000, 2) === 'admit') admits++;
    expect(admits).toBe(2);
  });

  it('convergence: two independent limiters fed the SAME op stream reach the SAME admit set', () => {
    const feed = (rl: EliteNicheRateLimiter) => {
      const admitted: string[] = [];
      const ops = [
        { id: 'o1', ts: 1_000_000 },
        { id: 'o2', ts: 1_000_050 },
        { id: 'o3', ts: 1_000_010 },
        { id: 'o4', ts: 1_000_000 + HOUR },
        { id: 'o5', ts: 1_000_020 },
      ];
      for (const o of ops) if (rl.decide(A, N1, o.id, o.ts, 2) === 'admit') admitted.push(o.id);
      return admitted;
    };
    expect(feed(new EliteNicheRateLimiter())).toEqual(feed(new EliteNicheRateLimiter()));
  });
});
