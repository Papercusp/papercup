/**
 * fleet-member-idle-verdict.test — P-023.
 *
 * The interesting assertions are the ORDERING ones. Each cause is easy to trigger alone; what
 * this oracle exists to get right is which cause wins when several are true at once, because
 * that is precisely where P-002's measured inversion lived (member blamed while the pool was
 * at factor 0). So every dominance pair below is tested with BOTH conditions true.
 */

import { describe, it, expect } from 'vitest';
import {
  computeMemberIdleVerdict,
  summariseIdleCauses,
  type MemberIdleInput,
  type FleetIdleContext,
} from './fleet-member-idle-verdict';

const FRESH = 120_000;
const ctx = (over: Partial<FleetIdleContext> = {}): FleetIdleContext => ({
  blockedAtLayer: null,
  midTurnFreshnessMs: FRESH,
  ...over,
});
// A member that is idle for no reason at all — the baseline every case perturbs.
const idle = (over: Partial<MemberIdleInput> = {}): MemberIdleInput => ({
  sessionState: 'live',
  load: 0,
  stalled: false,
  lastToolCallAgeMs: 600_000,
  contextPressure: 'ok',
  loopMode: 'work',
  ...over,
});

describe('computeMemberIdleVerdict — single causes', () => {
  it('holding claims and advancing is not idle', () => {
    const v = computeMemberIdleVerdict(idle({ load: 2 }), ctx());
    expect(v.cause).toBe('working');
    expect(v.remedy).toBeNull();
  });

  it('a held claim with no productive call past budget is stalled-holder even when generic liveness is fresh', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 1, stalled: false, lastToolCallAgeMs: 31 * 60_000, productiveToolCallAgeMs: 31 * 60_000 }),
      ctx(),
    );
    expect(v.cause).toBe('stalled-holder');
    expect(v.reason).toContain('last productive tool call was 31m ago');
    expect(v.remedy).toContain('Reclaim');
  });

  it('a fresh housekeeping call still wins over a stale productive age', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 1, stalled: false, lastToolCallAgeMs: 5_000, productiveToolCallAgeMs: 31 * 60_000 }),
      ctx(),
    );
    expect(v.cause).toBe('mid-turn');
    expect(v.remedy).toBeNull();
  });

  it('does not classify a held claim as stalled while a long local call is in flight', () => {
    const v = computeMemberIdleVerdict(
      idle({
        load: 1,
        stalled: false,
        productiveToolCallAgeMs: 31 * 60_000,
        longCallInFlight: { tool: 'capability:terminal', ageSec: 1_900 },
      }),
      ctx(),
    );
    expect(v.cause).toBe('working');
    expect(v.remedy).toBeNull();
  });

  it('a fresh tool call means mid-turn, not idle', () => {
    const v = computeMemberIdleVerdict(idle({ lastToolCallAgeMs: 5_000 }), ctx());
    expect(v.cause).toBe('mid-turn');
    expect(v.remedy).toBeNull();
    // The ambiguity must be stated, not hidden: a long local exec looks identical.
    expect(v.reason).toContain('local exec');
  });

  it('a provider wall reports throttled with an explicit do-nothing remedy', () => {
    const v = computeMemberIdleVerdict(idle({ throttled: { until: 'x' } }), ctx());
    expect(v.cause).toBe('throttled');
    expect(v.remedy).toContain('wait it out');
  });

  it.each(['ended', 'draining', 'suspect', 'recorded'])('sessionState %s is session-ending', (s) => {
    expect(computeMemberIdleVerdict(idle({ sessionState: s }), ctx()).cause).toBe('session-ending');
  });

  // EI-18730414627683753: loopMode null + nextFireAt null is the documented signature for a
  // permanently dormant member, which a leader previously had to spot by reading both by hand.
  it('no loop and no pending wake is no-self-wake, NOT genuinely-idle', () => {
    const v = computeMemberIdleVerdict(idle({ loopMode: null, nextFireAt: null }), ctx());
    expect(v.cause).toBe('no-self-wake');
    expect(v.remedy).toContain('loop:arm');
  });

  it('a loopless member WITH a pending wake is not no-self-wake', () => {
    const v = computeMemberIdleVerdict(
      idle({ loopMode: null, nextFireAt: '2026-08-09T21:00:00Z' }),
      ctx(),
    );
    expect(v.cause).not.toBe('no-self-wake');
  });

  it('a loopless member parked on a live event await is parked-awaiting-event, not no-self-wake', () => {
    const v = computeMemberIdleVerdict(
      idle({ loopMode: null, nextFireAt: null, parkedOn: ['fleet:item-completed:alpha'] }),
      ctx(),
    );
    expect(v.cause).toBe('parked-awaiting-event');
    expect(v.reason).toContain('live event await');
    expect(v.remedy).toContain('wait for the parked event');
  });

  it('critical context is context-exhausted', () => {
    expect(computeMemberIdleVerdict(idle({ contextPressure: 'critical' }), ctx()).cause).toBe(
      'context-exhausted',
    );
  });

  // CONTROL: the residual must remain reachable, and it is the ONLY case that says "wake it".
  it('a healthy idle member with nothing wrong upstream is genuinely-idle', () => {
    const v = computeMemberIdleVerdict(idle(), ctx());
    expect(v.cause).toBe('genuinely-idle');
    expect(v.remedy).toContain('wake');
  });

  it('never returns a wake remedy for any cause EXCEPT genuinely-idle', () => {
    const cases: MemberIdleInput[] = [
      idle({ load: 2 }),
      idle({ lastToolCallAgeMs: 5_000 }),
      idle({ throttled: {} }),
      idle({ sessionState: 'ended' }),
      idle({ loopMode: null, nextFireAt: null, parkedOn: ['fleet:item-completed:alpha'] }),
      idle({ contextPressure: 'critical' }),
    ];
    for (const m of cases) {
      const v = computeMemberIdleVerdict(m, ctx());
      expect(v.cause).not.toBe('genuinely-idle');
      expect(v.remedy ?? '').not.toContain('wake:required');
    }
  });
});

describe('computeMemberIdleVerdict — dominance (the P-002 inversion)', () => {
  // THE regression test for this whole item. Both true; the fleet layer must win, and the
  // remedy must NOT be "wake this member".
  it('a fleet block beats a member-level explanation and forbids the wake remedy', () => {
    const v = computeMemberIdleVerdict(idle(), ctx({ blockedAtLayer: 'inference-pool' }));
    expect(v.cause).toBe('fleet-blocked');
    expect(v.dominatedBy).toBe('inference-pool');
    expect(v.remedy).toContain('blockedAt.remedy');
    expect(v.remedy).not.toContain('wake:required');
  });

  // 'members' is deliberately NOT in this list — it is the no-upstream-layer sentinel, not a
  // dominating layer. See the WI-41198 block below.
  it.each(['fleet-paused', 'inference-pool', 'spec-scope', 'claim-floors'] as const)(
    'carries the dominating layer %s verbatim rather than re-deriving one',
    (layer) => {
      const v = computeMemberIdleVerdict(idle(), ctx({ blockedAtLayer: layer }));
      expect(v.dominatedBy).toBe(layer);
    },
  );

  // WI-41198 / WI-41183. 'members' is the LAST arm of FleetBlockLayer: the arbiter returns it
  // when NO upstream layer is blocking, i.e. the member level IS where to act. Reporting that
  // as 'fleet-blocked' inverts its meaning and — worse — masks the member-level causes below,
  // which are the only ones carrying an executable remedy. Measured: 16 of 31 members sat
  // unactionable for 3h+ under this, while actually being dead sessions with no pid.
  it("blockedAtLayer 'members' is NOT a fleet block — it is the sentinel for the opposite", () => {
    const v = computeMemberIdleVerdict(idle(), ctx({ blockedAtLayer: 'members' }));
    expect(v.cause).not.toBe('fleet-blocked');
    expect(v.dominatedBy).toBeUndefined();
    // and it must not tell the leader to go act on some other layer
    expect(v.remedy ?? '').not.toContain('blockedAt.remedy');
  });

  it("blockedAtLayer 'members' does not mask a dead session", () => {
    const v = computeMemberIdleVerdict(
      idle({ sessionState: 'ended' }),
      ctx({ blockedAtLayer: 'members' }),
    );
    expect(v.cause).toBe('session-ending');
  });

  it("blockedAtLayer 'members' does not mask a member with no wake source", () => {
    const v = computeMemberIdleVerdict(
      idle({ loopMode: null, nextFireAt: null }),
      ctx({ blockedAtLayer: 'members' }),
    );
    expect(v.cause).toBe('no-self-wake');
  });

  // A genuine upstream layer must still dominate — the fix must not disarm branch 4 wholesale.
  it('a real upstream layer still dominates a member-level cause', () => {
    const v = computeMemberIdleVerdict(
      idle({ loopMode: null, nextFireAt: null }),
      ctx({ blockedAtLayer: 'inference-pool' }),
    );
    expect(v.cause).toBe('fleet-blocked');
    expect(v.dominatedBy).toBe('inference-pool');
  });

  it('mid-turn beats a fleet block — an active member is not being prevented from anything', () => {
    const v = computeMemberIdleVerdict(
      idle({ lastToolCallAgeMs: 5_000 }),
      ctx({ blockedAtLayer: 'inference-pool' }),
    );
    expect(v.cause).toBe('mid-turn');
  });

  it('working beats everything', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 3, lastToolCallAgeMs: 900_000, throttled: {} }),
      ctx({ blockedAtLayer: 'fleet-paused' }),
    );
    expect(v.cause).toBe('working');
  });

  it('a STALLED holder is not reported as working', () => {
    const v = computeMemberIdleVerdict(idle({ load: 1, stalled: true }), ctx());
    expect(v.cause).toBe('stalled-holder');
    expect(v.remedy).toContain('Reclaim');
  });

  // EI-21282834431697166: a deliberately gate-parked member may still hold its claim while
  // waiting. The active park is the authoritative intent; reclaiming the claim would destroy
  // validated work that is correctly waiting on the declared event.
  it('a stalled holder parked on a live gate event is parked, not reclaimable', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 1, stalled: true, parkedOn: ['green-checkpoint:red:papercusp'] }),
      ctx(),
    );
    expect(v.cause).toBe('parked-awaiting-event');
    expect(v.reason).toContain('live event await');
    expect(v.remedy).toContain('wait for the parked event');
    expect(v.remedy).not.toContain('Reclaim');
  });

  // Found by running this oracle over the fleet's REAL rows: two members held stranded claims
  // during a pause, and 'fleet-blocked' hid the only thing the leader had to act on.
  it('a stranded claim beats a fleet block — reclaiming is needed whatever the fleet is doing', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 1, stalled: true }),
      ctx({ blockedAtLayer: 'fleet-paused' }),
    );
    expect(v.cause).toBe('stalled-holder');
  });

  it('but a stalled holder still taking turns is mid-turn, not stranded', () => {
    const v = computeMemberIdleVerdict(
      idle({ load: 1, stalled: true, lastToolCallAgeMs: 3_000 }),
      ctx(),
    );
    expect(v.cause).toBe('mid-turn');
  });

  it('a fleet block beats a per-member provider wall — one story, not N', () => {
    const v = computeMemberIdleVerdict(
      idle({ throttled: {} }),
      ctx({ blockedAtLayer: 'inference-pool' }),
    );
    expect(v.cause).toBe('fleet-blocked');
  });

  it('a paused fleet beats session-ending — a draining member is complying, not failing', () => {
    const v = computeMemberIdleVerdict(
      idle({ sessionState: 'draining' }),
      ctx({ blockedAtLayer: 'fleet-paused' }),
    );
    expect(v.cause).toBe('fleet-blocked');
  });

  it('an ending session is never reported mid-turn on a stale-but-fresh-looking call', () => {
    const v = computeMemberIdleVerdict(
      idle({ sessionState: 'ended', lastToolCallAgeMs: 1_000 }),
      ctx(),
    );
    expect(v.cause).toBe('session-ending');
  });

  it('a null lastToolCallAgeMs (still booting) is not mistaken for mid-turn', () => {
    const v = computeMemberIdleVerdict(idle({ lastToolCallAgeMs: null }), ctx());
    expect(v.cause).not.toBe('mid-turn');
  });
});

describe('own-spec attribution', () => {
  it("a member with its OWN spec is flagged unresolved rather than given the fleet's answer", () => {
    const v = computeMemberIdleVerdict(idle({ hasOwnSpec: true }), ctx({ blockedAtLayer: 'spec-scope' }));
    expect(v.ownSpecUnresolved).toBe(true);
  });

  it('a member inheriting the fleet spec carries no unresolved flag', () => {
    expect(computeMemberIdleVerdict(idle(), ctx()).ownSpecUnresolved).toBeUndefined();
  });
});

describe('summariseIdleCauses', () => {
  it('counts by cause', () => {
    const vs = [
      computeMemberIdleVerdict(idle({ load: 1 }), ctx()),
      computeMemberIdleVerdict(idle({ load: 1 }), ctx()),
      computeMemberIdleVerdict(idle(), ctx()),
    ];
    expect(summariseIdleCauses(vs)).toEqual({ working: 2, 'genuinely-idle': 1 });
  });

  // A cause that never fired must be ABSENT, not 0 — a zero reads as a measured absence.
  it('omits causes that never fired rather than reporting them as zero', () => {
    const out = summariseIdleCauses([computeMemberIdleVerdict(idle(), ctx())]);
    expect(out).not.toHaveProperty('throttled');
    expect(Object.keys(out)).toEqual(['genuinely-idle']);
  });

  it('an empty roster summarises to an empty map', () => {
    expect(summariseIdleCauses([])).toEqual({});
  });
});
