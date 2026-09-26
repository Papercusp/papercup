/** Independent P-005 progress oracles; optional subject is a copy-out mutant, never an in-tree edit. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { GoalPlacementEffect, GoalPlacementOpportunity } from './goal-placement-progress';

const { advanceGoalPlacementProgress }: typeof import('./goal-placement-progress') = process.env.PAPERCUSP_GOAL_PROGRESS_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_PROGRESS_PROBE).href)
  : await import('./goal-placement-progress');

const scopeKey = 'workspace/goal/plan/holder';
const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 0, minute)).toISOString();
const receipt = (n: number): GoalPlacementOpportunity => ({ deliveryToken: `delivery-${n}`,
  completedTurnRef: `native-turn-${n}`, offeredAt: at(n * 2), completedAt: at(n * 2 + 1),
  eligibleAtOffer: true, eligibleAtCompletion: true });
const effect = (n: number): GoalPlacementEffect => ({ kind: 'member-claim', ref: `claim-${n}`, at: at(n) });
const initial = () => advanceGoalPlacementProgress({ scopeKey, previous: null, now: at(1), effect: effect(0) });

describe('effect-based goal placement progress', () => {
  it('keeps the clock unmeasured until there is an effect or eligible delivery', () => {
    const first = advanceGoalPlacementProgress({ scopeKey, previous: null, now: at(1) });
    const later = advanceGoalPlacementProgress({ scopeKey, previous: first.state, now: at(55) });
    expect(later).toMatchObject({ ageMs: null, stalled: false, state: { opportunities: 0 } });
    expect(later.state).toEqual(first.state);
  });
  it('requires two different delivered and completed eligible opportunities before repair', () => {
    const one = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(3), opportunity: receipt(1) });
    expect(one).toMatchObject({ status: 'known', stalled: false, state: { opportunities: 1 } });
    const two = advanceGoalPlacementProgress({ scopeKey, previous: one.state, now: at(5), opportunity: receipt(2) });
    expect(two).toMatchObject({ stalled: true, ageMs: 300_000, state: { opportunities: 2, stalledAt: at(5) } });
    expect(initial().state.opportunities).toBe(0);
  });
  it('does not turn elapsed time, status reads or repeated effect observations into progress', () => {
    const before = initial().state;
    const read = advanceGoalPlacementProgress({ scopeKey, previous: before, now: at(45), effect: effect(0) });
    expect(read.state).toEqual(before);
    expect(read).toMatchObject({ stalled: false, ageMs: 2_700_000 });
  });
  it('does not renew the effect clock when the same receipt is presented with a later timestamp', () => {
    expect(advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(5),
      effect: { ...effect(0), at: at(5) } }).state.lastEffect).toEqual(effect(0));
  });
  it('counts a completed turn only once, despite duplicate delivery or a second token', () => {
    const one = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(3), opportunity: receipt(1) });
    for (const opportunity of [receipt(1), { ...receipt(1), deliveryToken: 'another-token' }]) {
      expect(advanceGoalPlacementProgress({ scopeKey, previous: one.state, now: at(6), opportunity }).state).toEqual(one.state);
    }
  });
  it.each(['eligibleAtOffer', 'eligibleAtCompletion'] as const)('excludes a blocked interval at %s and prevents replay', (key) => {
    const excluded = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(3),
      opportunity: { ...receipt(1), [key]: false } });
    expect(excluded.state.opportunities).toBe(0);
    expect(advanceGoalPlacementProgress({ scopeKey, previous: excluded.state, now: at(4), opportunity: receipt(1) }).state.opportunities).toBe(0);
  });
  it('never counts an unfinished/live call or a missing delivery receipt', () => {
    const live = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(20) });
    expect(live.state.opportunities).toBe(0);
    const missing = advanceGoalPlacementProgress({ scopeKey, previous: live.state, now: at(20),
      opportunity: { ...receipt(1), deliveryToken: '' } });
    expect(missing).toMatchObject({ status: 'unknown', stalled: false });
    expect(missing.state).toEqual(live.state);
  });
  it('resets opportunity debt only for a newer distinct verified effect', () => {
    const one = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(3), opportunity: receipt(1) });
    const stalled = advanceGoalPlacementProgress({ scopeKey, previous: one.state, now: at(5), opportunity: receipt(2) });
    const advanced = advanceGoalPlacementProgress({ scopeKey, previous: stalled.state, now: at(7), effect: effect(6) });
    expect(advanced).toMatchObject({ stalled: false, ageMs: 60_000, state: { opportunities: 0, stalledAt: null } });
    expect(advanceGoalPlacementProgress({ scopeKey, previous: advanced.state, now: at(8), opportunity: receipt(2) }).state).toEqual(advanced.state);
  });
  it('does not count a turn whose offered instruction predates the newly observed effect', () => {
    const result = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(5),
      effect: effect(4), opportunity: receipt(2) });
    expect(result.state.opportunities).toBe(0);
  });
  it('retains a fixed repair timestamp across further reads and missed opportunities', () => {
    const one = advanceGoalPlacementProgress({ scopeKey, previous: null, now: at(3), opportunity: receipt(1) });
    const two = advanceGoalPlacementProgress({ scopeKey, previous: one.state, now: at(5), opportunity: receipt(2) });
    const three = advanceGoalPlacementProgress({ scopeKey, previous: two.state, now: at(7), opportunity: receipt(3) });
    expect(three.state).toMatchObject({ opportunities: 2, stalledAt: at(5), firstEligibleAt: at(2), lastEffect: null });
  });
  it('rejects cross-scope and future evidence without mutating the prior state', () => {
    const previous = initial().state;
    for (const patch of [{ scopeKey: 'another-goal' }, { effect: effect(20) }, { opportunity: receipt(20) }]) {
      const result = advanceGoalPlacementProgress({ scopeKey, previous, now: at(10), ...patch });
      expect(result.status).toBe('unknown');
      expect(result.state).toEqual(previous);
    }
  });
  it('refuses a launch or heartbeat dressed up as a canonical effect', () => {
    const previous = initial().state;
    const result = advanceGoalPlacementProgress({ scopeKey, previous, now: at(10),
      effect: { kind: 'launch', ref: 'attempt', at: at(8) } as unknown as GoalPlacementEffect });
    expect(result.status).toBe('unknown');
    expect(result.state).toEqual(previous);
  });
  it.each([
    { opportunities: 2, stalledAt: at(2) },
    { lastEffect: effect(40) },
    { firstEligibleAt: 'not-a-time' },
  ])('keeps corrupt stored state unknown (%j)', (patch) => {
    const previous = { ...initial().state, ...patch };
    const result = advanceGoalPlacementProgress({ scopeKey, previous, now: at(10) });
    expect(result.status).toBe('unknown');
    expect(result.stalled).toBe(false);
    expect(result.state).toEqual(previous);
  });
  it('does not interpret truthy untyped eligibility as measured availability', () => {
    const result = advanceGoalPlacementProgress({ scopeKey, previous: initial().state, now: at(10),
      opportunity: { ...receipt(1), eligibleAtOffer: 1 } as unknown as GoalPlacementOpportunity });
    expect(result.status).toBe('unknown');
    expect(result.state.opportunities).toBe(0);
  });
});
