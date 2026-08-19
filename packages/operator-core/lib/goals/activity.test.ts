/**
 * goal activity — status folded over holder liveness
 * (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
 *
 * THE FALSIFIER THIS FILE EXISTS FOR is the first test below: a goal whose
 * holders are all dead AND whose status is `paused` must read `paused`, never
 * `lost`. That is the whole item — a deliberate stop and a crash look identical
 * from the outside, so the verdict has to come from the PERSISTED
 * administrative marker rather than from what is or is not running. Delete the
 * short-circuit in `resolveGoalActivity` and that test fails; nothing else here
 * would notice.
 */

import { describe, expect, it } from 'vitest';

import {
  GOAL_DORMANT_STATUS,
  GOAL_LIVENESS_SWEEP_STATUSES,
  isGoalQuietUnexpectedly,
  resolveGoalActivity,
  resolveGoalEffectiveActivity,
} from './activity';
import type { GoalHolderLiveness } from './holder';

const ALL_LIVENESS: GoalHolderLiveness[] = ['held', 'unheld', 'lost', 'unknown'];

describe('resolveGoalActivity — the administrative short-circuit', () => {
  it('a PAUSED goal reads `paused` whatever its holders resolve to', () => {
    for (const liveness of ALL_LIVENESS) {
      const v = resolveGoalActivity({ status: 'paused', liveness });
      expect(v.activity).toBe('paused');
      expect(v.deliberatelyPaused).toBe(true);
      // Liveness was never consulted, and the verdict says so rather than
      // echoing back an input it did not use.
      expect(v.liveness).toBeNull();
    }
  });

  it('specifically: dead holders + paused is NOT `lost` — the whole point of P-005', () => {
    expect(resolveGoalActivity({ status: 'paused', liveness: 'lost' }).activity).toBe('paused');
    expect(isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'paused', liveness: 'lost' }))).toBe(
      false,
    );
  });

  it('a TERMINAL goal short-circuits the same way — holders are irrelevant once it is over', () => {
    for (const status of ['achieved', 'killed']) {
      for (const liveness of ALL_LIVENESS) {
        const v = resolveGoalActivity({ status, liveness });
        expect(v.activity).toBe('terminal');
        expect(v.terminal).toBe(true);
        expect(v.deliberatelyPaused).toBe(false);
      }
    }
  });
});

describe('resolveGoalActivity — an active goal passes liveness through', () => {
  it('maps each liveness verdict one-for-one', () => {
    for (const liveness of ALL_LIVENESS) {
      const v = resolveGoalActivity({ status: 'active', liveness });
      expect(v.activity).toBe(liveness);
      expect(v.liveness).toBe(liveness);
      expect(v.deliberatelyPaused).toBe(false);
      expect(v.terminal).toBe(false);
    }
  });

  it('an ABSENT liveness reads `unknown`, never `lost`', () => {
    // "We were not told" and "we asked and nobody is alive" are different
    // answers, and only one of them is an alarm.
    expect(resolveGoalActivity({ status: 'active' }).activity).toBe('unknown');
    expect(resolveGoalActivity({ status: 'active', liveness: null }).activity).toBe('unknown');
  });

  it('an UNRECOGNISED status is treated as sweepable, not as a silent exemption', () => {
    // A status nobody classified must not accidentally inherit the pause
    // exemption — that is how `achieved` stayed invisible to the stop fan-out
    // (WI-37832). Anything not explicitly paused/terminal falls through to
    // liveness, where it is visible.
    expect(resolveGoalActivity({ status: 'sunsetted', liveness: 'lost' }).activity).toBe('lost');
    expect(resolveGoalActivity({ status: null, liveness: 'lost' }).activity).toBe('lost');
  });
});

describe('isGoalQuietUnexpectedly', () => {
  it('is TRUE only for unheld / lost', () => {
    expect(isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'active', liveness: 'lost' }))).toBe(
      true,
    );
    expect(
      isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'active', liveness: 'unheld' })),
    ).toBe(true);
  });

  it('is FALSE for `unknown` — a degraded oracle read is not evidence of abandonment', () => {
    expect(
      isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'active', liveness: 'unknown' })),
    ).toBe(false);
  });

  it('is FALSE for held, paused and terminal', () => {
    expect(isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'active', liveness: 'held' }))).toBe(
      false,
    );
    expect(isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'paused' }))).toBe(false);
    expect(isGoalQuietUnexpectedly(resolveGoalActivity({ status: 'killed' }))).toBe(false);
  });
});

describe('GOAL_LIVENESS_SWEEP_STATUSES', () => {
  it('names exactly the statuses a liveness judgement may be made about', () => {
    expect([...GOAL_LIVENESS_SWEEP_STATUSES]).toEqual(['active']);
  });

  it('every swept status genuinely falls through to liveness', () => {
    // The invariant that keeps the SQL predicate and the in-memory classifier
    // from drifting: if a status is swept, it must NOT short-circuit, or the
    // sweep would fetch rows the classifier then silently discards.
    for (const status of GOAL_LIVENESS_SWEEP_STATUSES) {
      const v = resolveGoalActivity({ status, liveness: 'lost' });
      expect(v.deliberatelyPaused).toBe(false);
      expect(v.terminal).toBe(false);
      expect(v.activity).toBe('lost');
    }
  });
});
