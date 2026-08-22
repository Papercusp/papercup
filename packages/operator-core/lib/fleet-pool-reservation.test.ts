/**
 * fleet-pool-reservation.test — P-024 / D-013.
 *
 * The two invariants under test are the ones that make this safe to act on:
 * a holder is NEVER held back at any pressure, and no scarcity means no recommendation.
 * Both are asserted with controls, because each is also trivially satisfied by a policy that
 * simply never recommends anything.
 */

import { describe, it, expect } from 'vitest';
import {
  assessPoolScarcity,
  computePoolReservation,
  DEFAULT_RESERVATION_CONFIG,
  type MemberReservationInput,
} from './fleet-pool-reservation';
import type { MemberIdleCause } from './fleet-member-idle-verdict';

const m = (agentId: string, idleCause: MemberIdleCause): MemberReservationInput => ({ agentId, idleCause });
const SCARCE = { factor: 0, queueDepth: 28 };
const HEALTHY = { factor: 1, queueDepth: 0 };

describe('assessPoolScarcity', () => {
  it('a low factor is scarce', () => {
    expect(assessPoolScarcity({ factor: 0, queueDepth: 0 }).scarce).toBe(true);
  });

  it('a deep queue is scarce even at a healthy factor', () => {
    const v = assessPoolScarcity({ factor: 1, queueDepth: 28 });
    expect(v.scarce).toBe(true);
    expect(v.reason).toContain('queueDepth 28');
  });

  // CONTROL: "not scarce" must remain reachable, or every scarcity assertion is vacuous.
  it('a healthy pool is not scarce', () => {
    const v = assessPoolScarcity(HEALTHY);
    expect(v.scarce).toBe(false);
    expect(v.unread).toBe(false);
  });

  // An unread signal must not trigger an action that costs pickup readiness — but must also not
  // be reported as measured-healthy.
  it('an UNREAD pool is not scarce, and says it is unread rather than healthy', () => {
    const v = assessPoolScarcity({ factor: null, queueDepth: null });
    expect(v.scarce).toBe(false);
    expect(v.unread).toBe(true);
    expect(v.reason).toContain('UNREAD');
  });

  it('reads scarcity from whichever leg IS readable', () => {
    expect(assessPoolScarcity({ factor: 0.1, queueDepth: null }).scarce).toBe(true);
    expect(assessPoolScarcity({ factor: null, queueDepth: 30 }).scarce).toBe(true);
    expect(assessPoolScarcity({ factor: null, queueDepth: 0 }).unread).toBe(false);
  });

  it('the thresholds are boundary-inclusive as documented', () => {
    const c = DEFAULT_RESERVATION_CONFIG;
    expect(assessPoolScarcity({ factor: c.scarceFactorAtOrBelow, queueDepth: 0 }).scarce).toBe(true);
    expect(assessPoolScarcity({ factor: null, queueDepth: c.scarceQueueDepthAtOrAbove }).scarce).toBe(true);
  });
});

describe('computePoolReservation — invariant: a holder is NEVER held back', () => {
  it.each(['working', 'stalled-holder'] as const)('%s is protected under maximum scarcity', (cause) => {
    const plan = computePoolReservation([m('a', cause)], SCARCE);
    expect(plan.members[0].disposition).toBe('protect');
    expect(plan.members[0].action).toBeUndefined();
  });

  it('no member holding work is ever held back, across every cause and both pool states', () => {
    const causes: MemberIdleCause[] = [
      'working', 'mid-turn', 'stalled-holder', 'fleet-blocked', 'throttled',
      'session-ending', 'no-self-wake', 'parked-awaiting-event', 'context-exhausted',
      'genuinely-idle',
    ];
    for (const pool of [SCARCE, HEALTHY, { factor: null, queueDepth: null }]) {
      const plan = computePoolReservation(causes.map((c) => m(c, c)), pool);
      for (const row of plan.members) {
        if (row.agentId === 'working' || row.agentId === 'stalled-holder') {
          expect(row.disposition).toBe('protect');
        }
      }
    }
  });
});

describe('computePoolReservation — invariant: no scarcity, no recommendation', () => {
  it('a healthy pool recommends nothing for anyone', () => {
    const plan = computePoolReservation([m('a', 'genuinely-idle'), m('b', 'mid-turn')], HEALTHY);
    expect(plan.counts['hold-back']).toBeUndefined();
    expect(plan.summary).toContain('No reservation recommended');
    for (const row of plan.members) expect(row.action).toBeUndefined();
  });

  it('an unread pool recommends nothing', () => {
    const plan = computePoolReservation([m('a', 'genuinely-idle')], { factor: null, queueDepth: null });
    expect(plan.counts['hold-back']).toBeUndefined();
    expect(plan.scarcity.unread).toBe(true);
  });
});

describe('computePoolReservation — the third option', () => {
  // CONTROL for the invariant above: hold-back must actually be reachable.
  it('an idle poller under scarcity IS held back', () => {
    const plan = computePoolReservation([m('a', 'genuinely-idle')], SCARCE);
    expect(plan.members[0].disposition).toBe('hold-back');
  });

  // The whole point of P-024: a third option that is not a bench.
  it('the recommended action parks on the claimable event and explicitly forbids benching', () => {
    const plan = computePoolReservation([m('a', 'genuinely-idle')], SCARCE);
    const action = plan.members[0].action ?? '';
    expect(action).toContain('work-item:claimable');
    expect(action).toContain('Do NOT fleet:bench');
  });

  it('never recommends a bench for ANY member in ANY state', () => {
    const causes: MemberIdleCause[] = [
      'working', 'mid-turn', 'stalled-holder', 'fleet-blocked', 'throttled',
      'session-ending', 'no-self-wake', 'parked-awaiting-event', 'context-exhausted',
      'genuinely-idle',
    ];
    for (const pool of [SCARCE, HEALTHY]) {
      for (const row of computePoolReservation(causes.map((c) => m(c, c)), pool).members) {
        expect(row.action ?? '').not.toMatch(/^fleet:bench/);
      }
    }
  });

  it.each([
    'throttled',
    'session-ending',
    'no-self-wake',
    'parked-awaiting-event',
    'context-exhausted',
    'fleet-blocked',
  ] as const)(
    '%s is not contending, so it is unaffected rather than held back',
    (cause) => {
      const plan = computePoolReservation([m('a', cause)], SCARCE);
      expect(plan.members[0].disposition).toBe('unaffected');
      expect(plan.members[0].reason).toContain('Not contending');
    },
  );

  it('a mid-turn member IS a poller under scarcity — it is consuming the pool right now', () => {
    expect(computePoolReservation([m('a', 'mid-turn')], SCARCE).members[0].disposition).toBe('hold-back');
  });
});

describe('computePoolReservation — reporting', () => {
  it('summarises a mixed roster', () => {
    const plan = computePoolReservation(
      [m('h1', 'working'), m('h2', 'stalled-holder'), m('i1', 'genuinely-idle'), m('i2', 'genuinely-idle'), m('t', 'throttled')],
      SCARCE,
    );
    expect(plan.counts).toEqual({ protect: 2, 'hold-back': 2, unaffected: 1 });
    expect(plan.summary).toContain('Park 2 idle poller(s)');
    expect(plan.summary).toContain('2 holder(s) protected');
  });

  it('says so plainly when scarcity is real but there is nobody to hold back', () => {
    const plan = computePoolReservation([m('h', 'working'), m('t', 'throttled')], SCARCE);
    expect(plan.counts['hold-back']).toBeUndefined();
    expect(plan.summary).toContain('No idle pollers to hold back');
  });

  it('omits dispositions that never fired rather than reporting them as zero', () => {
    const plan = computePoolReservation([m('h', 'working')], SCARCE);
    expect(Object.keys(plan.counts)).toEqual(['protect']);
  });

  it('an empty roster is handled', () => {
    const plan = computePoolReservation([], SCARCE);
    expect(plan.members).toEqual([]);
    expect(plan.counts).toEqual({});
  });
});
