/**
 * Coverage for op-backstory-state: the operator-persona backstory rate limiter
 * (max 3/session, 30-min cooldown, 7-day no-repeat per beat). Pure logic with an
 * injected clock; in node it uses the in-memory fallback store, so no stubbing
 * is needed. Reset between tests via the exported test seam.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  markBeatFired,
  backstoryEligibleNow,
  recentlyFiredIds,
  __resetBackstoryStateForTests,
  BACKSTORY_LIMITS,
} from './op-backstory-state';

const T0 = 1_000_000;
const { COOLDOWN_MS, NO_REPEAT_MS, MAX_PER_SESSION } = BACKSTORY_LIMITS;

beforeEach(() => __resetBackstoryStateForTests());

describe('backstoryEligibleNow — cooldown', () => {
  it('is eligible on a fresh session', () => {
    expect(backstoryEligibleNow(T0)).toBe(true);
  });

  it('blocks during the cooldown window after a fire, then re-allows', () => {
    markBeatFired('a', T0);
    expect(backstoryEligibleNow(T0 + 60_000)).toBe(false); // 1min < 30min cooldown
    expect(backstoryEligibleNow(T0 + COOLDOWN_MS)).toBe(true); // cooldown elapsed, fires < cap
  });
});

describe('backstoryEligibleNow — session cap', () => {
  it('blocks after MAX_PER_SESSION fires regardless of cooldown', () => {
    let t = T0;
    for (let i = 0; i < MAX_PER_SESSION; i++) {
      markBeatFired(`beat-${i}`, t);
      t += COOLDOWN_MS; // space them out so cooldown never blocks
    }
    expect(backstoryEligibleNow(t + COOLDOWN_MS)).toBe(false); // cap reached
  });
});

describe('recentlyFiredIds — 7-day no-repeat', () => {
  it('includes a recently-fired beat and drops it after the window', () => {
    markBeatFired('a', T0);
    expect(recentlyFiredIds(T0)).toEqual(new Set(['a']));
    expect(recentlyFiredIds(T0 + NO_REPEAT_MS + 1)).toEqual(new Set()); // window passed
  });

  it('re-firing a beat refreshes its no-repeat timestamp', () => {
    markBeatFired('a', T0);
    const nearExpiry = T0 + NO_REPEAT_MS - 1;
    markBeatFired('a', nearExpiry); // refresh
    // Past the ORIGINAL window but within the refreshed one → still excluded.
    expect(recentlyFiredIds(T0 + NO_REPEAT_MS + 10)).toEqual(new Set(['a']));
  });

  it('tracks multiple distinct beats', () => {
    markBeatFired('a', T0);
    markBeatFired('b', T0 + 1000);
    expect(recentlyFiredIds(T0 + 2000)).toEqual(new Set(['a', 'b']));
  });
});

describe('BACKSTORY_LIMITS', () => {
  it('exposes the documented limits', () => {
    expect(MAX_PER_SESSION).toBe(3);
    expect(COOLDOWN_MS).toBe(30 * 60_000);
    expect(NO_REPEAT_MS).toBe(7 * 24 * 60 * 60_000);
  });
});
