/**
 * leader-brief.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 *
 * projectMember is the PURE per-member reshape (fleet:assignments'
 * decoration output → the leader-lean brief row) — unit-tested directly, no
 * PG/DI ceremony (mirrors deriveMemberVerdict/deriveContextPressure).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeBenchSuggestion,
  computeDormantAlert,
  computeFloorStarvedFleetAlert,
  computeIdleWithClaimableAlert,
  computeSpecStarvedFleetAlert,
  computeStrandedFleetAlert,
  decorateComposedParkedOn,
  projectMember,
  reconcilePsuHostLiveness,
  resolveComposedParkedOn,
  selectLeaderBriefMembers,
  topExcludedFloors,
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

  // EI-18679536216711688 (recurrence guard): `stalled` is derived purely from MCP
  // tool-call recency, which is indistinguishable from a member mid a long
  // foreground exec (a test run) that emits no MCP calls until it returns — this
  // is exactly that fixture. The suggestion must NOT assert a specific wrong
  // cause (a fabricated diagnosis reading as fact invites a destructive
  // coord:send { endTurn: true } on a productively-working member); it must
  // hedge honestly and point at sessions:timeline as the disambiguation step
  // before any escalation.
  it('does NOT assert a confident wrong cause for a stalled+speaking member — hedges instead (foreground-exec false-positive)', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.reason.toLowerCase()).not.toContain('live-loop-polling');
    expect(s?.reason.toLowerCase()).toContain('may be genuinely wedged');
    expect(s?.reason.toLowerCase()).toContain('foreground exec');
    expect(s?.reason.toLowerCase()).toContain('sessions:timeline');
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

// EI-18730414627683753: a member with NO self-wake mechanism at all (no loop, no park,
// no claim) is a DISTINCT, more severe state than "laneless-idle" (which assumes a healthy
// armed loop will re-cycle it) — the live incident this closes had `bench_suggested`/
// `laneless_idle` fire for both dormant members, indistinguishable from a merely-idle
// loop-armed one, so the leader had to hand-inspect loopMode/nextFireAt per row to notice.
describe('computeDormantAlert (EI-18730414627683753)', () => {
  it('flags a first-turn-done member with no loop, not parked, no claim', () => {
    expect(
      computeDormantAlert({ verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
    ).toBe(true);
  });

  it('flags a speaking member in the same shape', () => {
    expect(
      computeDormantAlert({ verdict: 'speaking', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
    ).toBe(true);
  });

  it('does NOT flag a member with an active loop (work or monitor) — it will re-cycle on its own', () => {
    for (const loopMode of ['work', 'monitor'] as const) {
      expect(
        computeDormantAlert({ verdict: 'first-turn-done', loopMode, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBe(false);
    }
  });

  it('does NOT flag a member parked on an event — it has a wake mechanism', () => {
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: ['work-item:status:WI-1'],
        doing: null,
        load: 0,
        queued: [],
      }),
    ).toBe(false);
  });

  it('does NOT flag a member holding a claim or with queued work', () => {
    const holding = { id: 'WI-1', itemKind: 'bug', title: 'in progress', status: 'open', rank: 0, rankWriter: null, activity: 'alive' as const };
    expect(
      computeDormantAlert({ verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: holding, load: 1, queued: [] }),
    ).toBe(false);
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [{ id: 'WI-9' }] as never,
      }),
    ).toBe(false);
  });

  it('does NOT flag dead/booted/joined/monitoring/waiting — only speaking/first-turn-done are dormant-eligible', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'monitoring', 'waiting'] as const) {
      expect(
        computeDormantAlert({ verdict, loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBe(false);
    }
  });

  it('is suppressed for a paused (winding-down) fleet, matching every sibling alert', () => {
    expect(
      computeDormantAlert(
        { verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] },
        true,
      ),
    ).toBe(false);
  });

  it('projectMember surfaces `dormant:true` end-to-end, distinct from benchSuggestion', () => {
    const m = projectMember(baseAgent({ verdict: 'first-turn-done' }), NOW);
    expect(m.dormant).toBe(true);
    // Same idle shape also trips the (unchanged) laneless-idle benchSuggestion —
    // dormant is an ADDITIONAL, more urgent signal, not a replacement.
    expect(m.benchSuggestion?.kind).toBe('laneless-idle');
  });

  it('projectMember does NOT set `dormant` for a healthy loop-armed idle member', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting', loopMode: 'monitor' }), NOW);
    expect(m.dormant).toBeUndefined();
  });
});

// WI-5973: a fleet leader running its monitor loop is SUPPOSED to hold zero
// claims — that IS the documented leader contract (monitor each wake: burn-down
// delta, member liveness, completion-integrity audit, reclaim orphans). Before
// this fix, the leader's OWN row (fleetRole:'leader', loopMode:'monitor',
// verdict:'monitoring', isSelf:true) still tripped the EI-13846 laneless-idle
// heuristic written for MEMBERS pulling from a claim spec — and its paired
// remedy (fleet:bench the leader onto a scoped event) is the exact failure the
// leader contract exists to prevent: the one agent watching for member death
// goes to sleep. Observed live 2026-07-26 on nonp2p-bug-drain-0725 (twice).
describe('computeBenchSuggestion — the LEADER\'s own monitor row is never idle-cycling (WI-5973)', () => {
  it('does NOT flag a leader with fleetRole:"leader" + loopMode:"monitor", zero claims, not parked', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s).toBeUndefined();
  });

  it('does NOT flag the leader even when claimable work exists (the idle-with-claimable branch is ALSO leader-exempt)', () => {
    const s = computeBenchSuggestion(
      {
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole: 'leader',
        loopMode: 'monitor',
      },
      5, // claimableCount > 0 — would fire 'idle-with-claimable' for an ordinary member
    );
    expect(s).toBeUndefined();
  });

  it('STILL flags a member with fleetRole:"leader" but loopMode:"work" (a leader that also pulls work is not exempt)', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'work',
    });
    expect(s).toBeDefined();
  });

  it('STILL flags an ordinary member ("member"/null fleetRole) with loopMode:"monitor" — the exemption is leader-specific', () => {
    for (const fleetRole of ['member', null, undefined] as const) {
      const s = computeBenchSuggestion({
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole,
        loopMode: 'monitor',
      });
      expect(s).toBeDefined();
    }
  });

  it('does NOT suppress the stalled-no-mcp branch for a leader that DID take on work and looks wedged — still a genuine fault', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({
      stalled: true,
      verdict: 'speaking',
      parkedOn: [],
      doing: held,
      load: 1,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember never surfaces benchSuggestion for the leader\'s own monitoring row end-to-end', () => {
    const m = projectMember(
      baseAgent({ fleetRole: 'leader', loopMode: 'monitor', verdict: 'monitoring', monitorState: 'monitoring' }),
      NOW,
    );
    expect(m.benchSuggestion).toBeUndefined();
  });
});

// EI-18681259560385029 — the live incident: five members carried the laneless-idle line
// ("likely idle-cycling a drained or scoped-out lane") while claimableCount was 2, and the
// leader read it, concluded the lane was drained, and stood the fleet down. The wording
// asserted a fact it never checked; the remedy it named (fleet:bench) was backwards.
describe('computeBenchSuggestion — idle beside a NONEMPTY queue (EI-18681259560385029)', () => {
  const idle = { stalled: false, verdict: 'waiting' as const, parkedOn: [], doing: null, load: 0, queued: [] };

  it('does NOT claim the lane is drained when work IS claimable — and says so explicitly', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.kind).toBe('idle-with-claimable');
    expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    expect(s?.reason).toMatch(/lane is NOT drained/);
    // The regression in one line: it must never assert the queue is empty when it is not.
    expect(s?.reason).not.toMatch(/drained or scoped-out/);
  });

  it('does NOT recommend benching when the queue is nonempty — benching sleeps a member beside real work', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
    expect(s?.reason).toMatch(/wake/i);
  });

  it('keeps the historical bench advice when the lane is VERIFIED drained (0 claimable AND 0 matching)', () => {
    // EI-18689489507862177 TIGHTENED THIS TEST'S PREMISE. It used to pass `claimableCount: 0`
    // with no gating read and assert "VERIFIED drained" — but an empty queue alone cannot
    // establish drainage: a lane whose every matching row sits behind a claim floor reads 0
    // here too (measured live: 108 matched / 0 claimable). Verification now requires the
    // pre-floor match count as well, so the second argument below is what makes the claim
    // true. The test's INTENT is unchanged: a genuinely drained lane keeps the bench advice.
    const s = computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench/);
  });

  it('an UNREADABLE queue (null) is reported as unknown — never silently folded into "drained"', () => {
    for (const unknown of [null, undefined]) {
      const s = computeBenchSuggestion(idle, unknown);
      expect(s?.kind).toBe('laneless-idle');
      expect(s?.reason).toMatch(/could NOT be read/);
      expect(s?.reason).toMatch(/an unread queue is not an empty one/);
      expect(s?.reason).not.toMatch(/VERIFIED drained/);
    }
  });

  it('tags the stalled branch with its own kind so a leader can tell the two remedies apart', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing: held }, 5);
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember threads the claimable count through end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW, 3);
    expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(m.benchSuggestion?.reason).toMatch(/3 item\(s\) ARE claimable/);
  });
});

describe('computeIdleWithClaimableAlert (EI-18681259560385029 — the summary-level alert)', () => {
  it('fires on the exact incident shape: 5 idle members, 2 claimable', () => {
    const alert = computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member\(s\)/);
    expect(alert?.reason).toMatch(/2 item\(s\) are claimable/);
    expect(alert?.reason).toMatch(/wake/i);
  });

  it('does not fire when the queue is genuinely empty — idle beside nothing is correct', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 0, idleMemberCount: 5 })).toBeUndefined();
  });

  it('does not fire when every member is working, however full the queue', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 40, idleMemberCount: 0 })).toBeUndefined();
  });

  it('does NOT fire on an unreadable count — unknown is not evidence of a full queue either', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: null, idleMemberCount: 5 })).toBeUndefined();
  });

  it('fires even while OTHER members are busy — partial starvation is still starvation', () => {
    // Deliberately unlike computeStrandedFleetAlert/computeSpecStarvedFleetAlert, which both
    // require fleet-wide zero wip and so miss a fleet that is half-working, half-starving.
    expect(computeIdleWithClaimableAlert({ claimableCount: 1, idleMemberCount: 1 })).toBeDefined();
  });
});

// EI-18703234178947959 — the live incident (2026-07-26, fleet bug-drain-200k, 19 members):
// leader-brief reported `claimable_now: 2` + `idleWithClaimableAlert` and told the leader to
// wake all 19 members to "re-run scheduler:get_next", while THAT VERY ORACLE returned
// `windDown:true` for the same fleet (owner pause standing since 2026-07-21). The 2 rows were
// real backlog — real backlog OUTSIDE the paused fleet's scope. Idle members were COMPLYING
// with the stand-down; the brief diagnosed compliance as starvation, once per polling tick.
describe('a PAUSED (winding-down) fleet never gets a wake/bench suggestion (EI-18703234178947959)', () => {
  const idle = {
    stalled: false,
    verdict: 'waiting' as const,
    parkedOn: [],
    doing: null,
    load: 0,
    queued: [],
  };

  it('THE REGRESSION: idle + 2 claimable + fleet paused ⇒ no "wake it" suggestion at all', () => {
    // Unpaused, this is the EI-18681259560385029 shape and MUST still fire (guard against
    // over-suppression: the pause is the only thing that may silence it).
    expect(computeBenchSuggestion(idle, 2)?.kind).toBe('idle-with-claimable');
    expect(computeBenchSuggestion(idle, 2, null, true)).toBeUndefined();
  });

  it('suppresses the laneless-idle branches too — bench/widen-the-spec are equally moot while paused', () => {
    // Verified-drained, gated, and unknown-queue all reach the same idle branch.
    expect(computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} }, true)).toBeUndefined();
    expect(
      computeBenchSuggestion(idle, 0, { matchedByFilter: 108, excluded: { claimHold: 38 } }, true),
    ).toBeUndefined();
    expect(computeBenchSuggestion(idle, null, null, true)).toBeUndefined();
  });

  it('still reports a member that HOLDS a claim and looks wedged — that blocks the stand-down', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion(
      { stalled: true, verdict: 'speaking', parkedOn: [], doing: held },
      2,
      null,
      true,
    );
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('an unread control state (absent/false) is NOT a pause — a real starvation signal survives', () => {
    for (const notPaused of [undefined, null, false]) {
      expect(computeBenchSuggestion(idle, 2, null, notPaused)?.kind).toBe('idle-with-claimable');
    }
  });

  it('projectMember threads the pause through end-to-end', () => {
    const agent = baseAgent({ verdict: 'waiting', monitorState: 'waiting' });
    expect(projectMember(agent, NOW, 2).benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(projectMember(agent, NOW, 2, null, true).benchSuggestion).toBeUndefined();
  });

  it('suppresses BOTH summary alerts while paused — defence-in-depth behind the member gate', () => {
    // The exact numbers from the incident (2 claimable, idle members) — must stay silent.
    expect(
      computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: true }),
    ).toBeUndefined();
    expect(
      computeFloorStarvedFleetAlert({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 5,
        fleetPaused: true,
      }),
    ).toBeUndefined();
    // …and both still fire on the same inputs when the fleet is ACTIVE.
    expect(
      computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: false }),
    ).toBeDefined();
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeDefined();
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

/** The live nonp2p-bug-drain-0725 reading at 2026-07-26T07:00Z, used verbatim below so the
 *  tests assert the ACTUAL measured incident rather than an invented shape. */
const LIVE_GATED_LANE = {
  claimable: 0,
  matchedByFilter: 108,
  excluded: {
    federationDetector: 50,
    claimHold: 38,
    needsHuman: 11,
    taken: 8,
    observationLane: 1,
    externalBlocker: 1,
    planLaneReserved: 0,
    loopNoise: 0,
  },
};

describe('topExcludedFloors (EI-18689489507862177)', () => {
  it('ranks floors largest-first and drops the zero buckets', () => {
    expect(topExcludedFloors(LIVE_GATED_LANE.excluded)).toEqual([
      ['federationDetector', 50],
      ['claimHold', 38],
      ['needsHuman', 11],
    ]);
  });

  it('is empty (never throws) for an absent breakdown', () => {
    expect(topExcludedFloors(null)).toEqual([]);
    expect(topExcludedFloors(undefined)).toEqual([]);
  });
});

describe('computeFloorStarvedFleetAlert (EI-18689489507862177 — the GATED lane every sibling alert is blind to)', () => {
  it('fires on the exact live shape: 108 matched, 0 claimable, members idle', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member/);
    expect(alert?.reason).toMatch(/108 row/);
    expect(alert?.reason).toMatch(/ZERO survive the claim floors/);
  });

  it('names the dominant floors so the leader knows WHAT to clear, not just that something is wrong', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/federationDetector=50/);
    expect(alert?.reason).toMatch(/claimHold=38/);
  });

  it('tells the leader NOT to bench — benching is the harmful remedy this alert exists to prevent', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/Do NOT fleet:bench/);
    expect(alert?.reason).toMatch(/wind-down/);
  });

  it('does NOT fire when the spec matches nothing — that is computeSpecStarvedFleetAlert, not a floor problem', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 0, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire when work IS claimable — that is computeIdleWithClaimableAlert', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 4, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire when nobody is idle — a fully-busy fleet is not starving', () => {
    expect(
      computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 0 }),
    ).toBeUndefined();
  });

  it('does NOT fire on an unreadable claimable count — unknown is not evidence of a gated lane', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: null, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire on an unreadable match count — the gated verdict requires BOTH halves', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: null, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('still fires without a breakdown, just without naming floors (the count alone is the alert)', () => {
    const alert = computeFloorStarvedFleetAlert({
      claimable: 0,
      matchedByFilter: 108,
      idleMemberCount: 5,
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).not.toMatch(/buckets overlap/);
  });
});

describe('computeBenchSuggestion — GATED vs DRAINED (EI-18689489507862177)', () => {
  const idleMember = { verdict: 'monitoring' as const, load: 0, queued: [], doing: null, stalled: false };

  it('calls a gated lane GATED and withholds the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/GATED, not drained/);
    expect(s?.reason).toMatch(/108 row/);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
  });

  it('surfaces the dominant floor on the member row, so the leader sees the cause in place', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.reason).toMatch(/federationDetector=50/);
  });

  it('still reports a VERIFIED drained lane (0 claimable AND 0 matching) and keeps the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench it onto a scoped event/);
    expect(s?.reason).not.toMatch(/GATED/);
  });

  it('REFUSES to call the lane drained when the gating was not read — the unchecked assertion this item fixes', () => {
    // The regression guard: claimableCount===0 alone must never reproduce "VERIFIED drained".
    const s = computeBenchSuggestion(idleMember, 0, null);
    expect(s?.reason).not.toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/NOT read on this brief/);
    expect(s?.reason).toMatch(/excludedBreakdown/);
  });

  it('leaves the claimable>0 branch (EI-18681259560385029) untouched', () => {
    const s = computeBenchSuggestion(idleMember, 3, LIVE_GATED_LANE);
    expect(s?.kind).toBe('idle-with-claimable');
  });
});

describe('resolveComposedParkedOn (pure, EI-18732218464905145 — the false-deadlock rendering fix)', () => {
  it('collapses a composed root + its own leaf siblings into ONE entry, never as flat peers', () => {
    const trees = new Map([
      [96, { required: 1, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' as const }],
    ]);
    const out = resolveComposedParkedOn(
      ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'],
      trees,
    );
    expect(out).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('derives mode: all (required === leaf count), any (required 1), k-of-n (in between)', () => {
    const of3 = (required: number) =>
      resolveComposedParkedOn(
        ['composed-root:1'],
        new Map([[1, { required, leaves: ['a', 'b', 'c'], expiresTs: null, onTimeout: 'wake' as const }]]),
      )[0] as { mode: string };
    expect(of3(3).mode).toBe('all');
    expect(of3(1).mode).toBe('any');
    expect(of3(2).mode).toBe('k-of-n');
  });

  it('a plain (non-composed) parked key passes through unchanged, alongside a composed entry', () => {
    const trees = new Map([[1, { required: 1, leaves: ['x'], expiresTs: null, onTimeout: 'wake' as const }]]);
    const out = resolveComposedParkedOn(['lock:grant:t1', 'x', 'composed-root:1'], trees);
    expect(out).toContain('lock:grant:t1');
    expect(out).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'composed', rootId: 1 })]));
    // 'x' is a leaf of root 1 — consumed into the composed entry, not duplicated as a flat string.
    expect(out.filter((e) => e === 'x')).toHaveLength(0);
  });

  it('fails OPEN on an unresolved composed-root sentinel (no matching tree) — keeps the raw key visible', () => {
    const out = resolveComposedParkedOn(['composed-root:404'], new Map());
    expect(out).toEqual(['composed-root:404']);
  });

  it('empty input returns empty output', () => {
    expect(resolveComposedParkedOn([], new Map())).toEqual([]);
  });
});

describe('decorateComposedParkedOn (EI-18732218464905145)', () => {
  const node = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 96,
    rootId: 96,
    parentId: null,
    subscriberId: 'su-1',
    requiredCount: 1,
    firedCount: 0,
    firedAt: null,
    spec: null,
    wakeHandle: null,
    note: null,
    expiresTs: '2026-07-26T18:36:37Z',
    timeoutBehavior: 'wake' as const,
    cancelledAt: null,
    ...over,
  });
  const leaf = (eventKey: string, id: number) => ({
    id,
    eventKey,
    nodeId: 97,
    rootId: 96,
    memberFiredAt: null,
    memberPayload: null,
    firedAt: null,
    cancelledAt: null,
  });

  it('resolves parkedOnResolved for an agent whose parkedOn holds a composed-root sentinel', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const loadTreeLeaves = vi.fn(async () => [leaf('work-item:status:WI-6088', 1), leaf('work-item:status:WI-6095', 2)]);
    const agents = [
      { agentId: 'su-1', parkedOn: ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'] },
    ];
    await decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: loadTreeLeaves as never });
    expect(listActiveComposedRoots).toHaveBeenCalledWith('su-1');
    expect(loadTreeLeaves).toHaveBeenCalledWith(96);
    expect(agents[0].parkedOnResolved).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('skips the read entirely for an agent with no composed sentinel (no extra cost on the common case)', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const agents = [{ agentId: 'su-1', parkedOn: ['lock:grant:t1'] }, { agentId: 'su-2', parkedOn: [] }];
    await decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: vi.fn() as never });
    expect(listActiveComposedRoots).not.toHaveBeenCalled();
    expect(agents[0].parkedOnResolved).toBeUndefined();
  });

  it('a roots-read failure fails soft (via the shared withBoundedTimeout degrade) — never throws, keeps the raw sentinel visible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listActiveComposedRoots = vi.fn(async () => {
      throw new Error('pg down');
    });
    const agents = [{ agentId: 'su-1', parkedOn: ['composed-root:96'] }];
    await expect(
      decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: vi.fn() as never }),
    ).resolves.toBeDefined();
    // withBoundedTimeout degrades the failed read to its [] fallback rather than throwing, so
    // resolution proceeds with an empty tree map — resolveComposedParkedOn's own fail-open path
    // (asserted in isolation above) then keeps the unresolved sentinel visible, same as a genuine
    // 1.5s timeout would. Never silently drops the raw signal a leader could otherwise have seen.
    expect(agents[0].parkedOnResolved).toEqual(['composed-root:96']);
  });

  it('projectMember prefers parkedOnResolved over the raw flat parkedOn end-to-end', () => {
    const agent = baseAgent({
      parkedOn: ['work-item:status:WI-6088', 'composed-root:96'],
      parkedOnResolved: [
        { kind: 'composed', rootId: 96, mode: 'any', required: 1, of: 2, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' },
      ],
    });
    const m = projectMember(agent, NOW);
    expect(m.parkedOn).toEqual([
      { kind: 'composed', rootId: 96, mode: 'any', required: 1, of: 2, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' },
    ]);
  });

  it('projectMember falls back to the raw flat parkedOn when nothing was resolved (unchanged pre-fix behavior)', () => {
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });
});
