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
  type FleetFoldPresence,
} from './fleet-roster';
import type { AgentAssignment, WorkListItem } from './assignments';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';
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
  rankWriter: 'bee',
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

  it('annotates each persisted fleet with its live-member count (0 when none)', () => {
    const out = annotateFleetsWithCounts(
      [fleet('ui-fleet'), fleet('api-fleet')],
      new Map([['ui-fleet', 3]]),
    );
    expect(out.map((f) => [f.fleetSlug, f.liveMemberCount])).toEqual([
      ['ui-fleet', 3],
      ['api-fleet', 0],
    ]);
    // the durable registry row survives with zero live members (D-003) — still listed.
    expect(out.find((f) => f.fleetSlug === 'api-fleet')?.liveMemberCount).toBe(0);
  });
});
