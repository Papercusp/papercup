/**
 * cold-nohost-park-guard — pure-logic tests (EI-21431587306904888).
 *
 * The IO wrapper (`recordColdNoHostParkAndMaybeEscalate`) is fail-soft glue over
 * already-tested primitives (autoPauseLoopRoutine, recordFire, openEscalation);
 * its wake-executor wiring is covered in wake-executor.test.ts. What must be
 * airtight here is the STREAK ARITHMETIC — a wrong streak either escalates a
 * healthy loop (hair-trigger) or never escalates a black-holed one (the bug).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  coldNoHostEscalationFires,
  DEFAULT_COLD_NOHOST_ESCALATION_FIRES,
  nextColdNoHostParkStreak,
  parseColdNoHostParkStreak,
} from './cold-nohost-park-guard';

describe('nextColdNoHostParkStreak', () => {
  it('starts a fresh streak at 1 with no prior state', () => {
    expect(nextColdNoHostParkStreak(null, 5)).toEqual({ lastWakeCount: 5, streak: 1 });
  });

  it('advances on the immediately-next fire parking too (consecutive undeliverable fires)', () => {
    const s1 = nextColdNoHostParkStreak(null, 5);
    const s2 = nextColdNoHostParkStreak(s1, 6);
    const s3 = nextColdNoHostParkStreak(s2, 7);
    expect(s3).toEqual({ lastWakeCount: 7, streak: 3 });
  });

  it('a parked-row RETRY of the same fire (same wakeCount) never inflates the streak', () => {
    const s1 = nextColdNoHostParkStreak(null, 5);
    const retry = nextColdNoHostParkStreak(s1, 5);
    expect(retry).toEqual({ lastWakeCount: 5, streak: 1 });
    // ...and the retry does not break the chain: the NEXT fire still advances it.
    expect(nextColdNoHostParkStreak(retry, 6)).toEqual({ lastWakeCount: 6, streak: 2 });
  });

  it('a GAP in wakeCount means intervening fires were delivered — the streak resets', () => {
    // Fires 5,6 parked; 7-9 delivered (host came back); 10 parked again.
    const s2 = nextColdNoHostParkStreak(nextColdNoHostParkStreak(null, 5), 6);
    expect(nextColdNoHostParkStreak(s2, 10)).toEqual({ lastWakeCount: 10, streak: 1 });
  });

  it('a re-armed loop (wakeCount restarts at 1) resets a stale persisted streak', () => {
    // Stale metadata from a prior incarnation must never pre-satisfy the threshold.
    const stale = { lastWakeCount: 40, streak: 9 };
    expect(nextColdNoHostParkStreak(stale, 1)).toEqual({ lastWakeCount: 1, streak: 1 });
  });
});

describe('parseColdNoHostParkStreak', () => {
  it('round-trips a valid persisted value', () => {
    expect(parseColdNoHostParkStreak({ lastWakeCount: 3, streak: 2 })).toEqual({
      lastWakeCount: 3,
      streak: 2,
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'x'],
    ['missing streak', { lastWakeCount: 3 }],
    ['non-numeric', { lastWakeCount: 'a', streak: 'b' }],
    ['streak below 1', { lastWakeCount: 3, streak: 0 }],
  ])('malformed metadata (%s) parses to null instead of throwing', (_label, raw) => {
    expect(parseColdNoHostParkStreak(raw)).toBeNull();
  });
});

describe('coldNoHostEscalationFires', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_COLD_NOHOST_ESCALATION_FIRES;
  });

  it('defaults to the documented threshold', () => {
    expect(coldNoHostEscalationFires()).toBe(DEFAULT_COLD_NOHOST_ESCALATION_FIRES);
  });

  it('honors the env override', () => {
    process.env.PAPERCUSP_COLD_NOHOST_ESCALATION_FIRES = '5';
    expect(coldNoHostEscalationFires()).toBe(5);
  });

  it('floors at 2 — a single blip must never pause a loop', () => {
    process.env.PAPERCUSP_COLD_NOHOST_ESCALATION_FIRES = '1';
    expect(coldNoHostEscalationFires()).toBe(DEFAULT_COLD_NOHOST_ESCALATION_FIRES);
  });
});
