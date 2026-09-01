/**
 * WI-2092233 — the goal-steward claim gate.
 *
 * The properties under test are asymmetric on purpose, same as the sibling context-pressure
 * gate: refusing when we should serve (a false 'steward' reading) manufactures a false drain —
 * an agent idling while believing its lane is empty — so the fail-open cases are asserted at
 * least as hard as the refusal itself. The refusal is the contract half: an ELECTED goal holder
 * (or a live handoff window) never receives self-selected work, because the GOAL contract is
 * categorical (the holder never implements; every execution unit is a launched agent) and the
 * filed breach is exactly a steward self-pull followed by an hours-long strand on release.
 */
import { describe, it, expect } from 'vitest';
import {
  decideGoalStewardGate,
  goalStewardRefusalResult,
  GOAL_STEWARD_REFUSAL_CODE,
} from './goal-steward-claim-gate';
import type { GoalHolderAuthority } from '../goals/holder-authority';

function authority(status: GoalHolderAuthority['status'], goalId = 'work-on-everything'): GoalHolderAuthority {
  return {
    status,
    goalId: status === 'none' ? null : goalId,
    electedOwnerId: status === 'none' ? null : 'su-holder',
    electedEpoch: status === 'none' ? null : 3,
    handoffExpiresAt: status === 'handoff' ? new Date(Date.now() + 60_000).toISOString() : null,
  };
}

describe('decideGoalStewardGate', () => {
  it('REFUSES an elected holder, with a typed code and no lane claim', () => {
    const d = decideGoalStewardGate({ authority: authority('elected') });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.code).toBe(GOAL_STEWARD_REFUSAL_CODE);
    expect(d.diagnosis.goalStewardBlocked).toBe(true);
    expect(d.diagnosis.goalId).toBe('work-on-everything');
    expect(d.diagnosis.authorityStatus).toBe('elected');
    // A VERDICT, not silence — and explicitly not a drain claim (EI-19931420102632438).
    expect(d.diagnosis.laneEvaluated).toBe(false);
    expect(d.error).toMatch(/NOT evaluated/i);
    // The remedy names the contract's own route and the deliberate by-id escape.
    expect(d.error).toMatch(/place the work/i);
    expect(d.error).toMatch(/work_items:claim/);
  });

  it('REFUSES a live handoff window (predecessor still holds steward authority)', () => {
    const d = decideGoalStewardGate({ authority: authority('handoff') });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.diagnosis.authorityStatus).toBe('handoff');
    expect(d.error).toMatch(/HANDOFF window/i);
  });

  // ── fail-open axis: each of these SERVING is the point of the whole design ──
  it("serves 'none' and 'superseded' unchanged — ordinary agents, not stewards", () => {
    expect(decideGoalStewardGate({ authority: authority('none') })).toMatchObject({
      refuse: false,
      reason: 'not-steward',
    });
    expect(decideGoalStewardGate({ authority: authority('superseded') })).toMatchObject({
      refuse: false,
      reason: 'not-steward',
    });
  });

  it('serves on an unknown/unreadable authority — never coerced into a refusal', () => {
    expect(decideGoalStewardGate({ authority: null })).toMatchObject({
      refuse: false,
      reason: 'authority-unknown',
      authority: null,
    });
    expect(decideGoalStewardGate({ authority: undefined })).toMatchObject({
      refuse: false,
      reason: 'authority-unknown',
    });
  });

  it('kill-switch off serves even an elected holder, and is consulted before the authority', () => {
    expect(decideGoalStewardGate({ authority: authority('elected'), enabled: false })).toMatchObject({
      refuse: false,
      reason: 'gate-disabled',
    });
  });

  it('enabled defaults ON (finished work does not ship dark)', () => {
    const d = decideGoalStewardGate({ authority: authority('elected'), enabled: undefined });
    expect(d.refuse).toBe(true);
  });
});

describe('goalStewardRefusalResult', () => {
  it('emits the one shared wire shape both self-select surfaces return', () => {
    const d = decideGoalStewardGate({ authority: authority('elected') });
    if (!d.refuse) throw new Error('expected refusal');
    const wire = goalStewardRefusalResult(d);
    expect(wire).toMatchObject({
      ok: false,
      code: GOAL_STEWARD_REFUSAL_CODE,
    });
    expect(typeof wire.error).toBe('string');
    expect(wire.diagnosis).toMatchObject({ goalStewardBlocked: true, laneEvaluated: false });
  });
});
