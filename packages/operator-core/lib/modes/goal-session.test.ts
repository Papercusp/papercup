/**
 * goal-session — the rule both goal-aware boards key on (D-007/P-020).
 *
 * This suite carries a permanent FALSIFIABILITY CONTROL: `naiveIsGoalSession`
 * is the tempting wrong implementation — "the session is in goal mode" — kept
 * here forever rather than mutated into the real module for a one-off probe.
 * It is the shape a later reader is most likely to "simplify" the real function
 * back into, and the test asserts the two disagree on the case that matters. If
 * someone ever makes them agree, this file fails and says why.
 *
 * The calibration case (below) keeps that control honest: the real function has
 * to PASS the ordinary goal session, or "differs from naive" would be satisfied
 * by a function that simply always returns false.
 */

import { describe, it, expect } from 'vitest';
import { goalIdFromModes, isGoalSessionModes, GOAL_MODE, type ModeLike } from './goal-session';

const GOAL_ID = 'ship-the-focus-kit-84cff3';

/** THE CONTROL — deliberately wrong. Hides any session in goal mode, whether or
 *  not it has a goal to be hidden INTO. Never export; never call from source. */
function naiveIsGoalSession(modes: ReadonlyArray<ModeLike | string>): boolean {
  return modes.some((m) => typeof m !== 'string' && m.mode === GOAL_MODE);
}

const goalMode = (subject: string | null): ModeLike => ({ mode: GOAL_MODE, subject });

describe('goalIdFromModes', () => {
  it('returns the goal id for a session running a goal', () => {
    expect(goalIdFromModes([goalMode(GOAL_ID)])).toBe(GOAL_ID);
    // Calibration for the control below: the real function must accept this
    // case, so "disagrees with naive" cannot be satisfied by always-false.
    expect(isGoalSessionModes([goalMode(GOAL_ID)])).toBe(true);
  });

  it('returns null for a goal-mode session that has not filed its goal yet', () => {
    expect(goalIdFromModes([goalMode(null)])).toBeNull();
    expect(goalIdFromModes([{ mode: GOAL_MODE }])).toBeNull();
  });

  it('treats a blank or whitespace subject as no goal', () => {
    // The store normalizes '' to null, but the wire type permits a string and a
    // '' goal id would send the board looking for a card that cannot exist.
    expect(goalIdFromModes([goalMode('')])).toBeNull();
    expect(goalIdFromModes([goalMode('   ')])).toBeNull();
  });

  it('ignores subjects belonging to other mode axes', () => {
    // DRAIN's scope and GRADE's rubric ref occupy the same `subject` slot.
    expect(
      goalIdFromModes([
        { mode: 'drain', subject: 'harness:papercusp' },
        { mode: 'grade', subject: 'rubric:ideation' },
      ]),
    ).toBeNull();
  });

  it('finds the goal alongside other modes, in any order', () => {
    expect(goalIdFromModes([{ mode: 'auto', subject: null }, goalMode(GOAL_ID)])).toBe(GOAL_ID);
    expect(goalIdFromModes([goalMode(GOAL_ID), { mode: 'auto', subject: null }])).toBe(GOAL_ID);
  });

  it('tolerates the legacy bare-string mode form', () => {
    // A flattened mode id carries no subject, so it can never identify a goal.
    expect(goalIdFromModes(['goal', 'auto'])).toBeNull();
    expect(isGoalSessionModes(['goal'])).toBe(false);
  });

  it('tolerates an absent mode list', () => {
    expect(goalIdFromModes(null)).toBeNull();
    expect(goalIdFromModes(undefined)).toBeNull();
    expect(goalIdFromModes([])).toBeNull();
  });
});

describe('the naive "is in goal mode" rule is NOT what we ship', () => {
  it('disagrees with the control exactly where a session would vanish from both boards', () => {
    const notYetFiled = [goalMode(null)];

    // The control would hide it from the sessions pane...
    expect(naiveIsGoalSession(notYetFiled)).toBe(true);
    // ...while no goal card exists for it, so it would render nowhere at all.
    expect(isGoalSessionModes(notYetFiled)).toBe(false);
  });

  it('agrees with the control on an ordinary goal session', () => {
    // The two rules differ ONLY in the unfiled case — this pins that the real
    // function is a narrowing of the naive one, not a different rule.
    const running = [goalMode(GOAL_ID)];
    expect(naiveIsGoalSession(running)).toBe(true);
    expect(isGoalSessionModes(running)).toBe(true);
  });
});
