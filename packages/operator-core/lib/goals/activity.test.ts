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

/* ────────────────────────────────────────────────────────────────────────────
 * P-004 — deterministic deactivation
 *
 * THE FALSIFIER: the first test below. A holder-required goal that is
 * administratively `active` and has NO live holder must stop reading as active.
 * Delete the `isGoalQuietUnexpectedly` term from `resolveGoalEffectiveActivity`
 * and it fails. The three tests after it are the guards on the OTHER side — the
 * cases that must NEVER deactivate — because a deactivation rule that fires too
 * eagerly is the failure mode that empties a board, and each of those has its
 * own independent reason to be exempt.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('resolveGoalEffectiveActivity — P-004 deterministic deactivation', () => {
  it('DEACTIVATES an active, holder-required goal whose holders are all dead', () => {
    const v = resolveGoalEffectiveActivity({ status: 'active', liveness: 'lost' });
    expect(v.deactivated).toBe(true);
    expect(v.effectiveStatus).toBe(GOAL_DORMANT_STATUS);
    // The raw column is untouched — deactivation is DERIVED, never swept.
    expect(v.activity).toBe('lost');
    expect(v.requiresLiveHolder).toBe(true);
  });

  it('DEACTIVATES a goal that was never picked up (unheld)', () => {
    const v = resolveGoalEffectiveActivity({ status: 'active', liveness: 'unheld' });
    expect(v.deactivated).toBe(true);
    expect(v.effectiveStatus).toBe(GOAL_DORMANT_STATUS);
  });

  it('NEVER deactivates on `unknown` — a degraded oracle is not abandonment', () => {
    // THE LOAD-BEARING EXEMPTION. `resolveSessionStates` omits an entry when its
    // fetch degrades, so treating unknown as dead would blank every goal on the
    // board at once during one transient DB hiccup.
    const v = resolveGoalEffectiveActivity({ status: 'active', liveness: 'unknown' });
    expect(v.deactivated).toBe(false);
    expect(v.effectiveStatus).toBe('active');
  });

  it('NEVER deactivates a goal that is DELIBERATELY PAUSED, however dead its holders', () => {
    // D-009: the pause fan-out disarms exactly those sessions' loops, so a
    // paused goal having no live holder is its DESIGNED state, not a fault.
    const v = resolveGoalEffectiveActivity({ status: 'paused', liveness: 'lost' });
    expect(v.deactivated).toBe(false);
    expect(v.deliberatelyPaused).toBe(true);
    expect(v.effectiveStatus).toBe('paused');
  });

  it('NEVER deactivates a terminal goal', () => {
    for (const status of ['achieved', 'killed']) {
      const v = resolveGoalEffectiveActivity({ status, liveness: 'lost' });
      expect(v.deactivated).toBe(false);
      expect(v.effectiveStatus).toBe(status);
    }
  });

  it('NEVER deactivates a goal that opted out with holder.requireLive: false', () => {
    // The opt-out D-008 requires be SAYABLE: a goal driven by routines rather
    // than a held session is SUPPOSED to run unheld.
    const v = resolveGoalEffectiveActivity({
      status: 'active',
      launchSettings: { holder: { requireLive: false } },
      liveness: 'lost',
    });
    expect(v.deactivated).toBe(false);
    expect(v.requiresLiveHolder).toBe(false);
    expect(v.effectiveStatus).toBe('active');
  });

  it('applies the read-time DEFAULT (requireLive: true) to a goal that declared nothing', () => {
    // D-008's whole point: the default has to reach the 18 goals that already
    // exist, none of which carry a `holder` key. A create-time default would
    // cover none of them.
    for (const settings of [undefined, null, {}, { holder: null }, { holder: {} }]) {
      const v = resolveGoalEffectiveActivity({
        status: 'active',
        launchSettings: settings,
        liveness: 'lost',
      });
      expect(v.requiresLiveHolder).toBe(true);
      expect(v.deactivated).toBe(true);
    }
  });

  it('an explicit requireLive: true is honoured and is NOT reported as inherited', () => {
    const v = resolveGoalEffectiveActivity({
      status: 'active',
      launchSettings: { holder: { requireLive: true } },
      liveness: 'lost',
    });
    expect(v.deactivated).toBe(true);
    expect(v.policy.isDefault).toBe(false);
  });

  it('omitting liveness yields the SAFE answer, never a confident wrong one', () => {
    // A caller that has not paid for the oracle must not get a deactivation.
    const v = resolveGoalEffectiveActivity({ status: 'active' });
    expect(v.activity).toBe('unknown');
    expect(v.deactivated).toBe(false);
  });

  it('a held goal reads exactly as its raw status', () => {
    const v = resolveGoalEffectiveActivity({ status: 'active', liveness: 'held' });
    expect(v.deactivated).toBe(false);
    expect(v.effectiveStatus).toBe('active');
  });

  it('only a SWEPT status can deactivate — no other status is silently rewritten', () => {
    // Keeps the derived rule pinned to the same constant the sweep SQL uses, so
    // the two cannot drift apart (the drift shape STOPPING_STATUSES was made to
    // kill). Any status outside the swept set passes through untouched.
    for (const status of ['draft', 'someday', '', 'ACTIVE']) {
      const v = resolveGoalEffectiveActivity({ status, liveness: 'lost' });
      expect(v.deactivated).toBe(false);
      expect(v.effectiveStatus).toBe(status);
    }
  });

  it('GOAL_DORMANT_STATUS is not a persisted goal status', () => {
    // It must never be writable to goals.status. Keeping it disjoint from the
    // swept set is the cheap structural half of that guarantee.
    expect(GOAL_LIVENESS_SWEEP_STATUSES).not.toContain(GOAL_DORMANT_STATUS);
    expect(['active', 'paused', 'achieved', 'killed']).not.toContain(GOAL_DORMANT_STATUS);
  });

  it('deactivation is decided for EVERY liveness value exactly once', () => {
    // Exhaustive over the union, so a new liveness value cannot be added
    // without a deliberate decision here.
    const decided = ALL_LIVENESS.map((liveness) => ({
      liveness,
      deactivated: resolveGoalEffectiveActivity({ status: 'active', liveness }).deactivated,
    }));
    expect(decided).toEqual([
      { liveness: 'held', deactivated: false },
      { liveness: 'unheld', deactivated: true },
      { liveness: 'lost', deactivated: true },
      { liveness: 'unknown', deactivated: false },
    ]);
  });
});
