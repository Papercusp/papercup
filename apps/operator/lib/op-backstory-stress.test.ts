import { describe, it, expect, beforeEach } from 'vitest';
import {
  backstoryEligibleNow,
  markBeatFired,
  recentlyFiredIds,
  __resetBackstoryStateForTests,
  BACKSTORY_LIMITS,
} from './op-backstory-state';

beforeEach(() => __resetBackstoryStateForTests());

describe('backstory rate-limit boundary stress', () => {
  it('exactly 3 fires permitted; the 4th is rejected', () => {
    const t0 = 1_000_000;
    const cooldown = BACKSTORY_LIMITS.COOLDOWN_MS;
    expect(backstoryEligibleNow(t0)).toBe(true);
    markBeatFired('a', t0);
    expect(backstoryEligibleNow(t0 + cooldown + 1)).toBe(true);
    markBeatFired('b', t0 + cooldown + 1);
    expect(backstoryEligibleNow(t0 + 2 * (cooldown + 1))).toBe(true);
    markBeatFired('c', t0 + 2 * (cooldown + 1));
    expect(backstoryEligibleNow(t0 + 3 * (cooldown + 1))).toBe(false);
  });
  it('cooldown blocks even an eligible 2nd fire', () => {
    const t0 = 1_000_000;
    markBeatFired('a', t0);
    expect(backstoryEligibleNow(t0 + 1)).toBe(false);
    expect(backstoryEligibleNow(t0 + BACKSTORY_LIMITS.COOLDOWN_MS - 1)).toBe(false);
    expect(backstoryEligibleNow(t0 + BACKSTORY_LIMITS.COOLDOWN_MS)).toBe(true);
  });
  it('100 fires of distinct beats over months reset cleanly', () => {
    let t = 1_000_000;
    for (let i = 0; i < 100; i++) {
      __resetBackstoryStateForTests();
      markBeatFired(`b${i}`, t);
      t += 24 * 60 * 60 * 1000;
    }
    const recent = recentlyFiredIds(t);
    expect(recent.size).toBeLessThanOrEqual(7);
  });
});
