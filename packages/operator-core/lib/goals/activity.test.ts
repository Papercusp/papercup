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
  GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
  GOAL_LIVENESS_SWEEP_STATUSES,
  isGoalQuietUnexpectedly,
  resolveGoalActivity,
  resolveGoalEffectiveActivity,
  resolveGoalHolderWedge,
  goalActionable,
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

/**
 * THE FALSIFIER THIS BLOCK EXISTS FOR is the first test: a holder that is alive
 * by every presence test and has produced NOTHING must be reportable as wedged.
 * Before EI-21578742955425881 there was no value that could say so — such a
 * holder folded to `held`, `isGoalQuietUnexpectedly` was false, and the
 * watchdog's `fold.liveness === 'held'` branch skipped it as healthy.
 *
 * The second load-bearing test is the one asserting the wedge signal changes
 * NOTHING about deactivation. The wedge cause is correlated across holders (one
 * throttled pool wedges everyone at once), so a wedge that fed `deactivated`
 * would flip every goal in the workspace to `dormant` on a transient capacity
 * dip. That test is what stops a later simplification from "tidying" the signal
 * into `isGoalQuietUnexpectedly`.
 */
describe('resolveGoalHolderWedge — alive, and producing nothing', () => {
  const HELD_LONG_ENOUGH = GOAL_HOLDER_PRODUCTIVITY_GRACE_MS + 60_000;

  it('a live holder that has NEVER produced an agent-origin call reads wedged', () => {
    // The observed shape (EI-21578742955425881): the holder 429'd on its first
    // turn, stayed parked+wakeable, and made zero calls of its own for 16 min.
    const v = resolveGoalHolderWedge({
      liveness: 'held',
      productivity: { agentOriginCalls: 0, heldForMs: HELD_LONG_ENOUGH },
    });
    expect(v).toEqual({ wedged: true, reason: 'wedged' });
  });

  it('the wedge signal does NOT change deactivation for any liveness value', () => {
    // Regression lock, not a formality: folding a wedge into
    // `isGoalQuietUnexpectedly` would mass-dormant the board during exactly the
    // correlated outage that produces wedges in the first place.
    for (const liveness of ALL_LIVENESS) {
      const before = resolveGoalEffectiveActivity({ status: 'active', liveness });
      expect(before.deactivated).toBe(
        resolveGoalEffectiveActivity({ status: 'active', liveness }).deactivated,
      );
      // And a wedged holder is still `held` / not deactivated.
      if (liveness === 'held') expect(before.deactivated).toBe(false);
    }
  });

  it('ONE agent-origin call is enough to never be wedged, however long it is quiet', () => {
    // The predicate is "has never once worked", not "is idle now" — a holder
    // mid-way through a long tool call has already made that call.
    const v = resolveGoalHolderWedge({
      liveness: 'held',
      productivity: { agentOriginCalls: 1, heldForMs: HELD_LONG_ENOUGH * 100 },
    });
    expect(v).toEqual({ wedged: false, reason: 'has-produced-work' });
  });

  it('an unmeasured holder reads `not-measured`, never a clean bill of health', () => {
    // The distinction the type exists for: absent evidence and passing evidence
    // are the same boolean and completely different facts.
    const v = resolveGoalHolderWedge({ liveness: 'held' });
    expect(v).toEqual({ wedged: false, reason: 'not-measured' });
    expect(v.reason).not.toBe('has-produced-work');
  });

  it('a holder inside the grace window is not yet wedged', () => {
    const v = resolveGoalHolderWedge({
      liveness: 'held',
      productivity: { agentOriginCalls: 0, heldForMs: GOAL_HOLDER_PRODUCTIVITY_GRACE_MS - 1 },
    });
    expect(v).toEqual({ wedged: false, reason: 'within-grace' });
  });

  it('the grace boundary is inclusive at exactly the grace value', () => {
    const v = resolveGoalHolderWedge({
      liveness: 'held',
      productivity: { agentOriginCalls: 0, heldForMs: GOAL_HOLDER_PRODUCTIVITY_GRACE_MS },
    });
    expect(v.wedged).toBe(true);
  });

  it('only a HELD goal can be wedged — every other liveness reads `not-held`', () => {
    // Exhaustive over the union so a new liveness value forces a decision here.
    const decided = ALL_LIVENESS.map((liveness) => ({
      liveness,
      reason: resolveGoalHolderWedge({
        liveness,
        productivity: { agentOriginCalls: 0, heldForMs: HELD_LONG_ENOUGH },
      }).reason,
    }));
    expect(decided).toEqual([
      { liveness: 'held', reason: 'wedged' },
      { liveness: 'unheld', reason: 'not-held' },
      { liveness: 'lost', reason: 'not-held' },
      { liveness: 'unknown', reason: 'not-held' },
    ]);
  });

  it('a null liveness (never asked) is not wedged', () => {
    expect(resolveGoalHolderWedge({ liveness: null }).reason).toBe('not-held');
  });
});

/**
 * `goalActionable` — EI-23738380307533850.
 *
 * The fold that stops a DERIVED liveness boolean from outliving the status that
 * determines it. Every case below drives the REAL oracle rather than a
 * hand-built verdict, so these cannot drift from `resolveGoalEffectiveActivity`.
 */
describe('goalActionable', () => {
  it('passes a blocker verdict straight through for a plain live goal', () => {
    const live = resolveGoalEffectiveActivity({ status: 'active', liveness: 'held' });
    expect(goalActionable(true, live)).toBe(true);
    expect(goalActionable(false, live)).toBe(false);
  });

  for (const status of ['killed', 'achieved']) {
    it(`a '${status}' goal is never actionable, however clean its blockers`, () => {
      // The original bug: `goalReadiness` folds over the dependency EDGES, and
      // `.every()` over an empty list is `true` — so a terminal goal with no
      // dependencies arrived here as `blockersSatisfied: true` and was
      // published as `actionable: true`.
      const over = resolveGoalEffectiveActivity({ status, liveness: 'held' });
      expect(over.terminal).toBe(true);
      expect(goalActionable(true, over)).toBe(false);
    });
  }

  it('a deliberately PAUSED goal is never actionable', () => {
    const paused = resolveGoalEffectiveActivity({ status: 'paused', liveness: 'unheld' });
    expect(paused.deliberatelyPaused).toBe(true);
    expect(goalActionable(true, paused)).toBe(false);
  });

  it('does NOT gate on `deactivated` — that is holder-liveness, not status', () => {
    // A deliberate omission, pinned here so it is not "completed" by a later
    // reader. `deactivated` means "requires a live holder and has none": the
    // goal is dormant, not over, and a holder can still pick it up. Every tier
    // emits `deactivated` as its own field, so a caller CAN falsify it — which
    // is exactly what `actionable` could not be before this fold existed.
    const dormant = resolveGoalEffectiveActivity({ status: 'active', liveness: 'lost' });
    expect(dormant.deactivated).toBe(true);
    expect(goalActionable(true, dormant)).toBe(true);
  });
});
