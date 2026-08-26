/**
 * A member INSIDE a long call must not be reported as idle (EI-21548894457555139).
 *
 * The originating incident: `fleet:leader-brief` reported `dormant:true` and a
 * `laneless-idle` bench suggestion for a member that was working hard. Both verdicts
 * key off signals an unreturned call has not written — `load`/`doing` (a presence
 * snapshot) and settled-call ages — so a member 20 minutes into one call is
 * indistinguishable from an idle one on every other field of the row.
 *
 * Both misdiagnoses carry a REMEDY that makes them expensive rather than cosmetic:
 * `dormant` tells the leader to wake the member (interrupting the work), and
 * `benchSuggestion` tells it to bench (sleeping it on top of live work). These tests
 * pin the suppression, and each pairs with a control asserting the verdict still fires
 * when no call is in flight — otherwise a guard that suppressed everything
 * unconditionally would pass just as well.
 */

import { describe, expect, it } from 'vitest';
import { computeBenchSuggestion, computeDormantAlert } from './leader-brief';

/** The shape both verdicts read: alive, no claim, nothing queued, no loop. */
const IDLE_LOOKING = {
  load: 0,
  doing: null,
  parkedOn: [],
  queued: [],
  verdict: 'speaking' as const,
  loopMode: null,
  stalled: false,
};

describe('dormant — a member mid-call is not dormant', () => {
  it('CONTROL: without an in-flight call, the same row IS dormant', () => {
    // Calibration. If this fails, the fixture stopped reproducing the incident and the
    // suppression test below proves nothing.
    expect(computeDormantAlert({ ...IDLE_LOOKING })).toBe(true);
  });

  it('suppresses dormant while a call is in flight', () => {
    expect(
      computeDormantAlert({
        ...IDLE_LOOKING,
        longCallInFlight: { tool: 'testing:run', ageSec: 1200 },
      }),
    ).toBe(false);
  });
});

describe('benchSuggestion — a member mid-call must not be benched', () => {
  it('CONTROL: without an in-flight call, the same row DOES get a bench suggestion', () => {
    const suggestion = computeBenchSuggestion({ ...IDLE_LOOKING, loopMode: 'work' }, 0, {
      matchedByFilter: 0,
    });
    expect(suggestion?.kind).toBe('laneless-idle');
  });

  it('suppresses the bench suggestion while a call is in flight', () => {
    const suggestion = computeBenchSuggestion(
      {
        ...IDLE_LOOKING,
        loopMode: 'work',
        longCallInFlight: { tool: 'testing:run', ageSec: 1200 },
      },
      0,
      { matchedByFilter: 0 },
    );
    expect(suggestion).toBeUndefined();
  });

  it('suppresses idle-with-claimable too — the branch that says "wake it"', () => {
    // This branch is the most damaging one to get wrong: it explicitly prescribes
    // waking the member, which would interrupt the very call it is inside.
    const suggestion = computeBenchSuggestion(
      {
        ...IDLE_LOOKING,
        loopMode: 'work',
        longCallInFlight: { tool: 'testing:run', ageSec: 1200 },
      },
      5,
      { matchedByFilter: 5 },
    );
    expect(suggestion).toBeUndefined();
  });
});

describe('absence is not evidence of idleness', () => {
  it('an absent in-flight reading changes nothing — the old verdicts still stand', () => {
    // The registry is process-local, so "nothing observed" must degrade to exactly the
    // pre-existing behaviour rather than silently suppressing real alerts.
    expect(computeDormantAlert({ ...IDLE_LOOKING, longCallInFlight: null })).toBe(true);
    expect(computeDormantAlert({ ...IDLE_LOOKING, longCallInFlight: undefined })).toBe(true);
  });
});
