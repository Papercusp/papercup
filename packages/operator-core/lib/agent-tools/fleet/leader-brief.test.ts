/**
 * leader-brief.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 *
 * projectMember is the PURE per-member reshape (fleet:assignments'
 * decoration output → the leader-lean brief row) — unit-tested directly, no
 * PG/DI ceremony (mirrors deriveMemberVerdict/deriveContextPressure).
 */
import { describe, expect, it } from 'vitest';
import {
  computeBenchSuggestion,
  computeSpecStarvedFleetAlert,
  computeStrandedFleetAlert,
  projectMember,
  reconcilePsuHostLiveness,
  selectLeaderBriefMembers,
  type DecoratedAgent,
} from './leader-brief';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function baseAgent(overrides: Partial<DecoratedAgent> = {}): DecoratedAgent {
  return {
    agentId: 'su-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: new Date(NOW).toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: 'p2p-git',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

describe('reconcilePsuHostLiveness (WI-4755)', () => {
  it('marks a parked visible member ended when its psu host is gone', () => {
    const agent = baseAgent({ sessionState: 'parked' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('ended');
    expect(agent.alive).toBe(false);
  });

  it('preserves nursery cups without a psu host', () => {
    const agent = baseAgent({ sessionState: 'parked' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'cup']]), () => null);
    expect(agent.sessionState).toBe('parked');
    expect(agent.alive).toBe(true);
  });
});

describe('selectLeaderBriefMembers (EI-11840)', () => {
  it('keeps every live presence-backed member, including an idle member with no claims', () => {
    const members = selectLeaderBriefMembers(
      [
        baseAgent({ agentId: 'su-live-working', claims: [{ type: 'work-item', id: 'WI-1' }] as never }),
        baseAgent({ agentId: 'su-live-idle', claims: [], alive: true }),
        baseAgent({ agentId: 'su-other-fleet', fleetSlug: 'other-fleet', alive: true }),
        baseAgent({ agentId: 'su-stale', alive: false, claims: [] }),
      ],
      'p2p-git',
    );

    expect(members.map((member) => member.agentId)).toEqual([
      'su-live-working',
      'su-live-idle',
    ]);
  });

  it('includes stale canonical roster entries only when explicitly requested', () => {
    const stale = baseAgent({ agentId: 'su-stale', alive: false, claims: [] });
    expect(selectLeaderBriefMembers([stale], 'p2p-git')).toEqual([]);
    expect(selectLeaderBriefMembers([stale], 'p2p-git', true)).toEqual([stale]);
  });
});

describe('projectMember (pure)', () => {
  it('computes lastToolCallAgeMs from the ISO timestamp', () => {
    const agent = baseAgent({ lastToolCallAt: new Date(NOW - 5_000).toISOString() });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(5_000);
  });

  it('null lastToolCallAgeMs when the member has never taken a turn', () => {
    const agent = baseAgent({ lastToolCallAt: null });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBeNull();
  });

  it('collapses claims to queuedCount/load and bounded work-item ids, never the full claim records', () => {
    const agent = baseAgent({
      claims: [
        { type: 'work-item', id: 'WI-1' },
        { type: 'plan-item', id: 'P-1' },
        { type: 'work-item', id: 'WI-2' },
      ] as never,
      queued: [{ id: 'WI-1' }, { id: 'WI-2' }] as never,
      load: 3,
    });
    const m = projectMember(agent, NOW);
    expect(m.queuedCount).toBe(2);
    expect(m.load).toBe(3);
    expect(m.workItemIds).toEqual(['WI-1', 'WI-2']);
    expect('claims' in m).toBe(false);
  });

  it('omits `unanswered` when absent — never a bare zero/empty stub', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect('unanswered' in m).toBe(false);
  });

  it('carries `unanswered` verbatim when the decoration stamped one', () => {
    const unanswered = { count: 2, oldestAgeMs: 90_000, newest: [{ msgId: 'm1', from: 'su-2', ageMs: 1000 }] };
    const m = projectMember(baseAgent({ unanswered }), NOW);
    expect(m.unanswered).toEqual(unanswered);
  });

  it('omits `parkedOn` when empty/absent, carries it when non-empty (bench state)', () => {
    expect('parkedOn' in projectMember(baseAgent({ parkedOn: [] }), NOW)).toBe(false);
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });

  it('carries verdict/sessionState/wakeMode/contextPressure through as null when unstamped', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m.verdict).toBeNull();
    expect(m.sessionState).toBeNull();
    expect(m.wakeMode).toBeNull();
    expect(m.monitorState).toBeNull();
    expect(m.nextFireAt).toBeNull();
    expect(m.contextPressure).toBeNull();
    expect(m.loopMode).toBeNull();
  });

  it('carries healthy loop lifecycle and next fire through verbatim', () => {
    const m = projectMember(
      baseAgent({ monitorState: 'waiting', nextFireAt: '2026-07-10T12:01:00.000Z' }),
      NOW,
    );
    expect(m.monitorState).toBe('waiting');
    expect(m.nextFireAt).toBe('2026-07-10T12:01:00.000Z');
  });

  it("WI-5345: surfaces the member's armed loop mode inline (work vs monitor), independent of monitorState", () => {
    const wedgedMonitor = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'monitor' }),
      NOW,
    );
    expect(wedgedMonitor.monitorState).toBe('monitoring');
    expect(wedgedMonitor.doing).toBeNull();
    expect(wedgedMonitor.loopMode).toBe('monitor');

    const healthyBetweenItems = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'work' }),
      NOW,
    );
    // Same monitorState:'monitoring' + doing:null shape as the wedged case above — the
    // exact ambiguity WI-5345 reports — but loopMode now distinguishes them without a
    // separate loop:status{ownerId} call.
    expect(healthyBetweenItems.monitorState).toBe('monitoring');
    expect(healthyBetweenItems.doing).toBeNull();
    expect(healthyBetweenItems.loopMode).toBe('work');
  });
});

describe('computeBenchSuggestion (pure, EI-9943)', () => {
  const doing = { id: 'WI-1', itemKind: 'bug', title: 'stuck thing', status: 'open', rank: 0, rankWriter: null, activity: 'stalled' as const };

  it('flags a speaking member whose claim is stalled and not already benched', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.item).toBe('WI-1');
    expect(s?.itemTitle).toBe('stuck thing');
  });

  it('also flags first-turn-done (not just speaking) — the between-wakes window', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'first-turn-done', parkedOn: [], doing });
    expect(s).toBeDefined();
  });

  it('does NOT flag an already-benched member (parkedOn non-empty) — avoid re-nudging', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: ['some:event'], doing });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member that is not stalled', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a dead/booted/joined member — not burning turns, relaunch is the right lever', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'stalled', null] as const) {
      expect(computeBenchSuggestion({ stalled: true, verdict, parkedOn: [], doing })).toBeUndefined();
    }
  });

  it('projectMember surfaces benchSuggestion only when computeBenchSuggestion fires', () => {
    const flagged = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: [], doing }), NOW);
    expect(flagged.benchSuggestion).toBeDefined();
    const benched = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: ['k'], doing }), NOW);
    expect('benchSuggestion' in benched).toBe(false);
  });
});

describe('computeBenchSuggestion — LANELESS-IDLE (EI-13846)', () => {
  it('flags a speaking member with zero claims/queued and not parked', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null, load: 0, queued: [] });
    expect(s).toBeDefined();
    expect(s?.item).toBeNull();
    expect(s?.reason).toMatch(/idle-cycling/);
  });

  it("flags a LOOP-DRIVEN member ('monitoring'/'waiting' verdict) — the case `stalled`-gated speaking/first-turn-done could never catch", () => {
    for (const verdict of ['monitoring', 'waiting'] as const) {
      const s = computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] });
      expect(s).toBeDefined();
    }
  });

  it('does NOT flag a member already parked on an event (parked-awaiting-capability shape)', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'parked-awaiting-capability',
      parkedOn: ['work-item:claimable'],
      doing: null,
      load: 0,
      queued: [],
    });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member holding a real claim (load>0) or with queued work', () => {
    const holding = { id: 'WI-1', itemKind: 'bug', title: 'in progress', status: 'open', rank: 0, rankWriter: null, activity: 'alive' as const };
    expect(computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: holding, load: 1, queued: [] })).toBeUndefined();
    expect(
      computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: null, load: 0, queued: [{ id: 'WI-9' }] as never }),
    ).toBeUndefined();
  });

  it('does NOT flag dead/booted/joined — a fresh boot or a dead session is not "idle-cycling"', () => {
    for (const verdict of ['dead', 'booted', 'joined'] as const) {
      expect(computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] })).toBeUndefined();
    }
  });

  it('load/queued omitted (pre-EI-13846 call sites) never falsely triggers — undefined reads as "not laneless"', () => {
    expect(computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: null })).toBeUndefined();
  });

  it('projectMember surfaces the laneless-idle suggestion end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW);
    expect(m.benchSuggestion).toBeDefined();
    expect(m.benchSuggestion?.reason).toMatch(/idle-cycling/);
  });
});

describe('computeStrandedFleetAlert (EI-15055 — the whole-fleet-asleep-on-available-supply shape)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, ≥1 parked member, ≥1 unowned critical', () => {
    const alert = computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 8 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/7 member/);
    expect(alert?.reason).toMatch(/8 unowned critical/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 1, parkedCount: 7, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when nobody is parked (parkedCount 0) even if criticals sit unowned', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 0, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when there is no known unowned-critical supply (a genuinely drained fleet resting is fine)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 0 })).toBeUndefined();
  });
});

describe('computeSpecStarvedFleetAlert (EI-18655873409999215 — the spec-matches-zero blind spot computeStrandedFleetAlert cannot see)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, spec matches 0 of a nonempty pool', () => {
    const alert = computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 1224 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/0 of 1224 claimable/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0) — a per-bee override spec may still be pulling', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 1, specMatched: 0, poolSize: 1224 })).toBeUndefined();
  });

  it('does NOT fire when the pool itself is empty — a genuinely drained harness is fine, not a spec bug', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 0 })).toBeUndefined();
  });

  it('does NOT fire when the spec matches at least one row — this is not the starved-spec shape', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 3, poolSize: 1224 })).toBeUndefined();
  });
});
