/**
 * fleet-roster — named-su-agent-fleets P-005. Pure tests for the fleet-keyed clone of
 * the hive-roster fold: the fleet_slug filter, the fold (preserves the
 * {doing,queued,load,orphaned} work-detail and layers presence + the fleet label +
 * Tier-1 on top), and the registry "available = live-member-count" annotation — all
 * without PG.
 */
import { describe, it, expect } from 'vitest';
import {
  filterPresenceToFleet,
  foldFleetRoster,
  annotateFleetsWithCounts,
  isBeeRole,
  splitFleetRosterCounts,
  type FleetFoldPresence,
} from './fleet-roster';
import type { AgentAssignment, WorkListItem } from './assignments';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { AgentFleetRecord } from '../agent-fleets-store';

const NOW = Date.parse('2026-06-29T04:00:00Z');

function pres(p: Partial<FleetFoldPresence> & { ownerId: string }): FleetFoldPresence {
  return {
    ownerLabel: null,
    source: 'omp-hook-session',
    intent: '',
    currentPlanSlug: null,
    host: null,
    startedAt: null,
    heartbeatAt: null,
    lastActiveAt: null,
    agentRole: null,
    fleetSlug: null,
    fleetRole: null,
    userId: null,
    stale: false,
    ...p,
  };
}

const WI = (id: string, rank: number | null = null): WorkListItem => ({
  id,
  itemKind: 'feature',
  title: `work ${id}`,
  status: 'wip',
  rank,
  rankWriter: 'cup',
  activity: 'progressing',
});

function asg(p: Partial<AgentAssignment> & { agentId: string }): AgentAssignment {
  return {
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: null,
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: null,
    fleetRole: null,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...p,
  };
}

const wake = (m: Record<string, Partial<WakeabilitySignals>>): Map<string, WakeabilitySignals> => {
  const out = new Map<string, WakeabilitySignals>();
  for (const [k, v] of Object.entries(m)) out.set(k, { wakeable: false, liveTurn: false, ...v });
  return out;
};

const tier1 = (m: Record<string, Partial<PresenceTier1Joins>>): Map<string, PresenceTier1Joins> => {
  const out = new Map<string, PresenceTier1Joins>();
  for (const [k, v] of Object.entries(m)) {
    out.set(k, {
      claimedItems: [],
      model: null,
      awaitingEvent: false,
      awaitingEventKey: null,
      awaitingNote: null,
      wakeMode: 'auto',
      ...v,
    });
  }
  return out;
};

describe('filterPresenceToFleet', () => {
  const rows = [
    pres({ ownerId: 'a', fleetSlug: 'ui-fleet' }),
    pres({ ownerId: 'b', fleetSlug: 'api-fleet' }),
    pres({ ownerId: 'c', fleetSlug: null }), // in no fleet
  ];

  it('keeps exactly the fleet members (no unattributed by default)', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', false).map((r) => r.ownerId)).toEqual(['a']);
  });

  it('includes NULL-fleet agents when includeUnattributed is true', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', true).map((r) => r.ownerId)).toEqual(['a', 'c']);
  });

  it('never leaks another fleet', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', true).some((r) => r.ownerId === 'b')).toBe(false);
  });
});

describe('foldFleetRoster', () => {
  it('preserves the work-detail and layers presence + fleet label + Tier-1 on top', () => {
    const a = asg({
      agentId: 'su-x',
      label: 'su · su-x',
      alive: true,
      heartbeatAt: '2026-06-29T03:59:00Z',
      doing: WI('WI-1', 0),
      queued: [WI('WI-1', 0), WI('WI-2', 1)],
      load: 2,
    });
    const p = pres({
      ownerId: 'su-x',
      ownerLabel: 'su · su-x',
      host: 'box1',
      agentRole: 'su',
      fleetSlug: 'ui-fleet',
      fleetRole: 'leader',
      lastActiveAt: '2026-06-29T03:59:30Z',
    });
    const [e] = foldFleetRoster([p], [a], tier1({ 'su-x': { claimedItems: ['P-006'], model: 'opus' } }), NOW);
    // work-detail preserved verbatim
    expect(e.doing).toEqual(WI('WI-1', 0));
    expect(e.load).toBe(2);
    // presence + fleet label attached
    expect(e.agentRole).toBe('su');
    expect(e.fleetSlug).toBe('ui-fleet');
    expect(e.fleetRole).toBe('leader');
    expect(e.host).toBe('box1');
    expect(e.lastActiveSecAgo).toBe(30);
    // Tier-1 attached
    expect(e.claimedItems).toEqual(['P-006']);
    expect(e.model).toBe('opus');
    expect(e.federated).toBe(false);
  });

  it('includes a presence-only idle member with empty work-detail + its fleet label', () => {
    const p = pres({ ownerId: 'su-idle', intent: 'thinking', fleetSlug: 'ui-fleet', fleetRole: 'member' });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW);
    expect(e.agentId).toBe('su-idle');
    expect(e.doing).toBeNull();
    expect(e.fleetSlug).toBe('ui-fleet');
    expect(e.fleetRole).toBe('member');
    expect(e.intent).toBe('thinking');
    expect(e.claimedItems).toEqual([]); // EMPTY_TIER1 default
  });

  // EI-5858: fleet:status reported a stale `live` boolean that masked `ended`.
  it('gates `alive` to false + reports sessionState:ended for a warm-heartbeat but NOT-wakeable (dead) session', () => {
    // The reported repro: a session whose process ended but whose heartbeat is still
    // fresh within PRESENCE_STALE_MS. Presence/assignment liveness (heartbeat-only)
    // reads alive:true; wakeability says it is NOT wakeable → ended.
    const p = pres({ ownerId: 'su-dead', stale: false, fleetSlug: 'f' });
    const a = asg({ agentId: 'su-dead', alive: true, doing: WI('WI-9', 0), load: 1 });
    const [e] = foldFleetRoster([p], [a], tier1({}), NOW, wake({ 'su-dead': { wakeable: false } }));
    expect(e.sessionState).toBe('ended');
    expect(e.alive).toBe(false); // ← the fix: was `true` (masked the dead session)
  });

  it('reports sessionState live | parked and keeps alive for wakeable sessions', () => {
    const live = pres({ ownerId: 'su-live', stale: false, fleetSlug: 'f' });
    const parked = pres({ ownerId: 'su-parked', stale: false, fleetSlug: 'f' });
    const out = foldFleetRoster(
      [live, parked],
      [asg({ agentId: 'su-live', alive: true }), asg({ agentId: 'su-parked', alive: true })],
      tier1({}),
      NOW,
      wake({
        'su-live': { wakeable: true, liveTurn: true },
        'su-parked': { wakeable: true, liveTurn: false },
      }),
    );
    const byId = new Map(out.map((e) => [e.agentId, e]));
    expect(byId.get('su-live')?.sessionState).toBe('live');
    expect(byId.get('su-live')?.alive).toBe(true);
    expect(byId.get('su-parked')?.sessionState).toBe('parked');
    expect(byId.get('su-parked')?.alive).toBe(true);
  });

  // fleet-liveness-zombie-await-2026-07-07: a reboot-killed member leaves a live
  // wake-await (wakeable:true) but an hour-cold heartbeat. Pre-fix it read `parked`
  // and was COUNTED a live member (the invisible-dead-fleet bug the leader hit);
  // now the DEAD-ceiling backstop forces it to `ended`.
  it('classifies a wakeable-but-hour-cold member as ended (zombie await from an abrupt death)', () => {
    const p = pres({
      ownerId: 'su-zombie',
      stale: true,
      fleetSlug: 'f',
      fleetRole: 'member',
      agentRole: 'su',
      heartbeatAt: '2026-06-29T02:48:00Z', // 72 min before NOW — past the 30m DEAD ceiling
    });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW, wake({ 'su-zombie': { wakeable: true, liveTurn: false } }));
    expect(e.sessionState).toBe('ended'); // was 'parked' pre-fix
    expect(e.alive).toBe(false);
    // fleet:status derives memberCount off the roster with sessionState==='ended'
    // filtered out — so a dead-but-wakeable member no longer inflates the live count.
    const live = [e].filter((m) => m.sessionState !== 'ended');
    expect(splitFleetRosterCounts(live)).toEqual({ members: 0, bees: 0 });
  });

  it('does NOT over-reach: a wakeable member cold < the DEAD ceiling stays parked', () => {
    // Same wakeable+idle shape, but the heartbeat is only ~15 min cold (stale, yet
    // inside the 30m ceiling) → still `parked` (a recently-parked, resumable session).
    const p = pres({
      ownerId: 'su-recent-park',
      stale: true,
      fleetSlug: 'f',
      heartbeatAt: '2026-06-29T03:45:00Z', // 15 min before NOW
    });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW, wake({ 'su-recent-park': { wakeable: true, liveTurn: false } }));
    // The distinguishing signal is sessionState (parked, resumable — NOT ended);
    // `alive` is heartbeat-derived and already false for any stale row.
    expect(e.sessionState).toBe('parked');
    expect(e.alive).toBe(false);
  });

  it('leaves alive heartbeat-derived + sessionState null when wakeability is absent (federated/unknown)', () => {
    // No wakeability entry (a federated peer, or the read was unavailable) → behavior
    // unchanged: alive stays heartbeat-derived and sessionState is null (state unknown).
    const p = pres({ ownerId: 'fed:peer', stale: false, fleetSlug: 'f', federated: true });
    const [e] = foldFleetRoster([p], [asg({ agentId: 'fed:peer', alive: true })], tier1({}), NOW, wake({}));
    expect(e.sessionState).toBeNull();
    expect(e.alive).toBe(true);
  });

  it('sorts live first, then orphan-holders, then newest heartbeat', () => {
    const out = foldFleetRoster(
      [
        pres({ ownerId: 'stale-old', stale: true, heartbeatAt: '2026-06-29T01:00:00Z', fleetSlug: 'f' }),
        pres({ ownerId: 'live', stale: false, heartbeatAt: '2026-06-29T03:00:00Z', fleetSlug: 'f' }),
        pres({ ownerId: 'stale-new', stale: true, heartbeatAt: '2026-06-29T03:30:00Z', fleetSlug: 'f' }),
      ],
      [asg({ agentId: 'stale-old', alive: false, orphaned: true })],
      tier1({}),
      NOW,
    );
    expect(out.map((e) => e.agentId)).toEqual(['live', 'stale-old', 'stale-new']);
  });
});

describe('annotateFleetsWithCounts (available = >=1 live member)', () => {
  const fleet = (slug: string): AgentFleetRecord => ({
    workspaceId: 'ws',
    fleetSlug: slug,
    title: slug,
    description: null,
    owner: 'su-x',
    leaderOwnerId: 'su-x',
    colorScheme: null,
    createdAt: 1,
    updatedAt: 1,
  });

  it('annotates each persisted fleet with its live member/bee counts (0 when none)', () => {
    const out = annotateFleetsWithCounts(
      [fleet('ui-fleet'), fleet('api-fleet'), fleet('bee-only-fleet')],
      new Map([
        ['ui-fleet', { members: 3, bees: 0 }],
        // WI-1764 #4: a fleet with 0 members but live bees — the substrate mismatch.
        ['bee-only-fleet', { members: 0, bees: 2 }],
      ]),
    );
    expect(out.map((f) => [f.fleetSlug, f.liveMemberCount, f.beeCount])).toEqual([
      ['ui-fleet', 3, 0],
      ['api-fleet', 0, 0],
      ['bee-only-fleet', 0, 2],
    ]);
    // the durable registry row survives with zero live members (D-003) — still listed.
    expect(out.find((f) => f.fleetSlug === 'api-fleet')?.liveMemberCount).toBe(0);
    // the mismatch tell: 0 members yet 2 background bees grouped into the fleet.
    const beeOnly = out.find((f) => f.fleetSlug === 'bee-only-fleet');
    expect(beeOnly?.liveMemberCount).toBe(0);
    expect(beeOnly?.beeCount).toBe(2);
  });
});

describe('isBeeRole / splitFleetRosterCounts (WI-1764 #4 member-vs-bee split)', () => {
  it('isBeeRole is true only for the background-nursery bee role', () => {
    expect(isBeeRole('cup')).toBe(true);
    expect(isBeeRole('su')).toBe(false);
    expect(isBeeRole('human')).toBe(false);
    expect(isBeeRole(null)).toBe(false);
    expect(isBeeRole(undefined)).toBe(false);
  });

  it('splits a roster into visible desktop members vs background bees', () => {
    const counts = splitFleetRosterCounts([
      { agentRole: 'su' },
      { agentRole: 'su' },
      { agentRole: 'cup' },
      { agentRole: null }, // unlabeled → counts as a member, not a bee
    ]);
    expect(counts).toEqual({ members: 3, bees: 1 });
  });

  it('an all-bee roster reports 0 members (the substrate mismatch)', () => {
    expect(splitFleetRosterCounts([{ agentRole: 'cup' }, { agentRole: 'cup' }])).toEqual({
      members: 0,
      bees: 2,
    });
  });

  it('an empty roster is 0/0', () => {
    expect(splitFleetRosterCounts([])).toEqual({ members: 0, bees: 0 });
  });
});
