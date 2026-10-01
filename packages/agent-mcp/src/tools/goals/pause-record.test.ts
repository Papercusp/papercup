/**
 * The goal deliberate-pause record (goal-live-holder-guarantee-2026-08-18
 * P-005, D-009).
 *
 * The two failures these pin are the two the routines layer actually suffered,
 * one per direction:
 *
 *  - WRITE: a pause that silently dropped the rest of the metadata document.
 *    Goal metadata carries `spentCents` / `drainFleet` / `startedBy` written by
 *    other paths, so a stamp that replaced rather than merged would be a
 *    data-loss bug wearing an audit-trail costume.
 *  - READ: a record written and never read back (EI-19336000265007219) — hence
 *    the tolerance cases, because a reader that throws on partial jsonb is one
 *    a caller will wrap in a try/catch and then ignore.
 */

import { describe, expect, it } from 'vitest';

import {
  clearGoalDispositionOnReactivation,
  clearGoalPause,
  isGoalAdministrativelyPaused,
  readGoalLastPause,
  readGoalPause,
  stampGoalPause,
} from './pause-record';

const AT = 1_755_000_000_000;

describe('stampGoalPause', () => {
  it('writes { reason, pausedBy, pausedAtMs } under `pause`', () => {
    const next = stampGoalPause(null, { reason: 'owner hold', pausedBy: 'su-abc', nowMs: AT });
    expect(next.pause).toEqual({ reason: 'owner hold', pausedBy: 'su-abc', pausedAtMs: AT });
  });

  it('PRESERVES every other metadata key — the data-loss case', () => {
    const prev = { spentCents: 4200, drainFleet: 'fleet-a', startedBy: 'su-zzz' };
    const next = stampGoalPause(prev, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT });
    expect(next.spentCents).toBe(4200);
    expect(next.drainFleet).toBe('fleet-a');
    expect(next.startedBy).toBe('su-zzz');
  });

  it('does not mutate the input document', () => {
    const prev: Record<string, unknown> = { spentCents: 1 };
    stampGoalPause(prev, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT });
    expect(prev).toEqual({ spentCents: 1 });
  });

  it('re-stamping an already-paused goal replaces the record with the newer one', () => {
    const first = stampGoalPause(null, { reason: 'first', pausedBy: 'su-a', nowMs: AT });
    const second = stampGoalPause(first, { reason: 'second', pausedBy: 'su-b', nowMs: AT + 1000 });
    expect(second.pause).toEqual({ reason: 'second', pausedBy: 'su-b', pausedAtMs: AT + 1000 });
  });
});

describe('clearGoalPause', () => {
  it('moves the record to `lastPause` with a resumedAtMs stamp', () => {
    const paused = stampGoalPause({ spentCents: 7 }, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT });
    const resumed = clearGoalPause(paused, { nowMs: AT + 5000 });
    expect(resumed.pause).toBeUndefined();
    expect(resumed.lastPause).toEqual({
      reason: 'hold',
      pausedBy: 'su-abc',
      pausedAtMs: AT,
      resumedAtMs: AT + 5000,
    });
    expect(resumed.spentCents).toBe(7);
  });

  it('is a no-op when there is nothing to clear — callers need no `if`', () => {
    expect(clearGoalPause({ spentCents: 7 }, { nowMs: AT })).toEqual({ spentCents: 7 });
    expect(clearGoalPause(null, { nowMs: AT })).toEqual({});
  });

  it('does not mutate the input document', () => {
    const prev = stampGoalPause(null, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT });
    clearGoalPause(prev, { nowMs: AT + 1 });
    expect(prev.pause).toEqual({ reason: 'hold', pausedBy: 'su-abc', pausedAtMs: AT });
  });
});

describe('clearGoalDispositionOnReactivation (EI-24732367604234855)', () => {
  const STAMP = {
    disposition: 'killed',
    dispositionBy: 'su-holder',
    dispositionAt: '2026-09-30T22:38:28.000Z',
    handoffTo: 'su-next',
  };

  it('drops the whole stamp on killed → active and achieved → active, keeping every other key', () => {
    for (const prev of ['killed', 'achieved']) {
      expect(clearGoalDispositionOnReactivation({ ...STAMP, spentCents: 7 }, prev, 'active')).toEqual({
        spentCents: 7,
      });
    }
  });

  it('also clears on terminal → paused (the goal is no longer terminal)', () => {
    expect(clearGoalDispositionOnReactivation({ ...STAMP }, 'killed', 'paused')).toEqual({});
  });

  it('KEEPS the stamp when the goal stays or becomes terminal, or was never terminal', () => {
    expect(clearGoalDispositionOnReactivation({ ...STAMP }, 'killed', 'killed')).toEqual(STAMP);
    expect(clearGoalDispositionOnReactivation({ ...STAMP }, 'killed', 'achieved')).toEqual(STAMP);
    // handoff leaves the goal ACTIVE with the stamp — active → active must not erase it.
    expect(clearGoalDispositionOnReactivation({ ...STAMP }, 'active', 'active')).toEqual(STAMP);
    expect(clearGoalDispositionOnReactivation({ ...STAMP }, 'paused', 'active')).toEqual(STAMP);
  });

  it('is a no-op on empty metadata and does not mutate the input', () => {
    expect(clearGoalDispositionOnReactivation(null, 'killed', 'active')).toEqual({});
    const prev = { ...STAMP };
    clearGoalDispositionOnReactivation(prev, 'killed', 'active');
    expect(prev).toEqual(STAMP);
  });
});

describe('readGoalPause / readGoalLastPause', () => {
  it('renders pausedAtMs as an ISO string — every consumer compares timestamps, not numbers', () => {
    const paused = stampGoalPause(null, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT });
    expect(readGoalPause(paused)).toEqual({
      reason: 'hold',
      by: 'su-abc',
      at: new Date(AT).toISOString(),
    });
  });

  it('returns null when the goal is not paused', () => {
    expect(readGoalPause(null)).toBeNull();
    expect(readGoalPause({})).toBeNull();
    expect(readGoalPause({ spentCents: 1 })).toBeNull();
  });

  it('tolerates a partial or wrongly-typed record rather than throwing', () => {
    expect(readGoalPause({ pause: { reason: 42, pausedAtMs: 'nope' } })).toEqual({
      reason: null,
      by: null,
      at: null,
    });
    expect(readGoalPause({ pause: 'paused' })).toBeNull();
  });

  it('a non-finite pausedAtMs reads as an absent timestamp, never Invalid Date', () => {
    expect(readGoalPause({ pause: { pausedAtMs: Number.NaN } })?.at).toBeNull();
  });

  it('reads the archived record back after a resume', () => {
    const resumed = clearGoalPause(
      stampGoalPause(null, { reason: 'hold', pausedBy: 'su-abc', nowMs: AT }),
      { nowMs: AT + 1000 },
    );
    expect(readGoalPause(resumed)).toBeNull();
    expect(readGoalLastPause(resumed)).toEqual({
      reason: 'hold',
      by: 'su-abc',
      at: new Date(AT).toISOString(),
    });
  });
});

describe('isGoalAdministrativelyPaused', () => {
  it('is TRUE only for the persisted administrative marker', () => {
    expect(isGoalAdministrativelyPaused('paused')).toBe(true);
  });

  it('is FALSE for every other status, and for an absent one', () => {
    for (const s of ['active', 'achieved', 'killed', 'Paused', 'PAUSED', '', null, undefined]) {
      expect(isGoalAdministrativelyPaused(s as string | null | undefined)).toBe(false);
    }
  });
});
