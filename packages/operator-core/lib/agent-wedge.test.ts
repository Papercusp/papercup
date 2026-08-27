/**
 * agent-wedge — the subject-agnostic present-but-unproductive rule.
 *
 * The cases here are the ones drawn from the measured population (2026-08-27,
 * 22 of 166 present sessions), not invented shapes: a hook-only session, a
 * never-booted presence row, an oracle that declined to answer.
 */
import { describe, it, expect } from 'vitest';

import {
  AGENT_PRODUCTIVITY_GRACE_MS,
  resolveAgentWedge,
  type AgentProductivity,
} from './agent-wedge';
import {
  GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
  resolveGoalHolderWedge,
} from './goals/activity';

const PAST_GRACE = AGENT_PRODUCTIVITY_GRACE_MS + 60_000;

describe('resolveAgentWedge', () => {
  it('reports a present agent that has never produced an agent-origin call as wedged', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 0, anyOriginCalls: 0, presentForMs: PAST_GRACE },
    });
    expect(v.wedged).toBe(true);
    expect(v.reason).toBe('wedged');
  });

  // The whole point of excluding hook-origin calls: this session emitted real
  // invocations and is still wedged. A raw count would have read 3 and passed.
  it('wedges a session whose only calls are hook-origin, and calls it booted-never-worked', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 0, anyOriginCalls: 3, presentForMs: PAST_GRACE },
    });
    expect(v).toEqual({ wedged: true, reason: 'wedged', phase: 'booted-never-worked' });
  });

  it('calls a presence row with no calls of ANY origin never-booted', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 0, anyOriginCalls: 0, presentForMs: PAST_GRACE },
    });
    expect(v.phase).toBe('never-booted');
  });

  // Null means "not determined". A guessed phase would send the wrong repair.
  it('leaves phase null when anyOriginCalls was not supplied, rather than guessing', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 0, presentForMs: PAST_GRACE },
    });
    expect(v.wedged).toBe(true);
    expect(v.phase).toBeNull();
  });

  it('never wedges an agent that has produced work', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 1, anyOriginCalls: 1, presentForMs: PAST_GRACE },
    });
    expect(v).toEqual({ wedged: false, reason: 'has-produced-work', phase: null });
  });

  it('holds fire inside the grace window', () => {
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: { agentOriginCalls: 0, anyOriginCalls: 0, presentForMs: 60_000 },
    });
    expect(v).toEqual({ wedged: false, reason: 'within-grace', phase: null });
  });

  // An absent measurement and a passing measurement are the same boolean and
  // completely different facts. This is the assertion that keeps them apart.
  it('distinguishes an unmeasured agent from a healthy one', () => {
    const v = resolveAgentWedge({ presence: 'present' });
    expect(v.reason).toBe('not-measured');
    expect(v.reason).not.toBe('has-produced-work');
    expect(v.wedged).toBe(false);
  });

  it.each(['absent', 'unknown'] as const)(
    'suppresses for a %s subject even with a wedge-shaped measurement',
    (presence) => {
      const productivity: AgentProductivity = {
        agentOriginCalls: 0,
        anyOriginCalls: 0,
        presentForMs: PAST_GRACE,
      };
      expect(resolveAgentWedge({ presence, productivity })).toEqual({
        wedged: false,
        reason: 'not-present',
        phase: null,
      });
    },
  );

  it('honours an explicit graceMs override in both directions', () => {
    const productivity: AgentProductivity = {
      agentOriginCalls: 0,
      anyOriginCalls: 2,
      presentForMs: 120_000,
    };
    expect(resolveAgentWedge({ presence: 'present', productivity, graceMs: 60_000 }).wedged).toBe(
      true,
    );
    expect(resolveAgentWedge({ presence: 'present', productivity, graceMs: 600_000 }).wedged).toBe(
      false,
    );
  });
});

/**
 * The delegation must be invisible from the goal side. These pin the wrapper's
 * published shape, which several consumers and its own suite match EXACTLY —
 * a leaked `phase` key would break them.
 */
describe('resolveGoalHolderWedge delegates without changing its own contract', () => {
  it('returns exactly { wedged, reason } — no phase key leaks through', () => {
    const v = resolveGoalHolderWedge({
      liveness: 'held',
      productivity: { agentOriginCalls: 0, heldForMs: PAST_GRACE },
    });
    expect(v).toEqual({ wedged: true, reason: 'wedged' });
    expect(Object.keys(v).sort()).toEqual(['reason', 'wedged']);
  });

  it("still says 'not-held' — the general rule's 'not-present' is translated back", () => {
    expect(resolveGoalHolderWedge({ liveness: null }).reason).toBe('not-held');
    expect(resolveGoalHolderWedge({ liveness: 'lost' }).reason).toBe('not-held');
    expect(resolveGoalHolderWedge({ liveness: 'unheld' }).reason).toBe('not-held');
  });

  it('shares ONE grace constant with the general rule', () => {
    expect(GOAL_HOLDER_PRODUCTIVITY_GRACE_MS).toBe(AGENT_PRODUCTIVITY_GRACE_MS);
  });

  // Calibration: the goal wrapper and the general rule must agree on every
  // liveness value, or the delegation has quietly changed behaviour somewhere.
  it.each([
    ['held', 'wedged', true],
    ['lost', 'not-held', false],
    ['unheld', 'not-held', false],
    ['unknown', 'not-held', false],
  ] as const)('liveness %s → reason %s', (liveness, reason, wedged) => {
    const v = resolveGoalHolderWedge({
      liveness,
      productivity: { agentOriginCalls: 0, heldForMs: PAST_GRACE },
    });
    expect(v).toEqual({ wedged, reason });
  });
});
