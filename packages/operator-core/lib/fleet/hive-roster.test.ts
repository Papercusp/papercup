/**
 * hive-roster — presence-v2 Phase 3 fold (P-006/P-015). Pure tests: the merge +
 * hive-filter assert the fold preserves the fleet {doing,queued,load,orphaned}
 * shape and layers presence + Tier-1 on top, with no PG.
 */
import { describe, it, expect } from 'vitest';
import {
  filterPresenceToHive,
  foldHiveRoster,
  type FoldPresence,
} from './hive-roster';
import type { AgentAssignment, WorkListItem } from './assignments';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';

const NOW = Date.parse('2026-06-14T04:00:00Z');

function pres(p: Partial<FoldPresence> & { ownerId: string }): FoldPresence {
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
    hiveSlug: null,
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
    claims: [],
    orphaned: false,
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

describe('filterPresenceToHive', () => {
  const rows = [
    pres({ ownerId: 'a', hiveSlug: 'papercup' }),
    pres({ ownerId: 'b', hiveSlug: 'other' }),
    pres({ ownerId: 'c', hiveSlug: null }), // SU / standalone
  ];

  it('keeps the matching hive and (by default) NULL-hive standalone agents', () => {
    expect(filterPresenceToHive(rows, 'papercup', true).map((r) => r.ownerId)).toEqual(['a', 'c']);
  });

  it('drops NULL-hive agents when includeUnattributed is false', () => {
    expect(filterPresenceToHive(rows, 'papercup', false).map((r) => r.ownerId)).toEqual(['a']);
  });

  it('never leaks another hive', () => {
    expect(filterPresenceToHive(rows, 'papercup', true).some((r) => r.ownerId === 'b')).toBe(false);
  });
});

describe('foldHiveRoster', () => {
  it('preserves the fleet work-detail and layers presence + Tier-1 on top', () => {
    const a = asg({
      agentId: 'su-x',
      label: 'su · su-x',
      alive: true,
      heartbeatAt: '2026-06-14T03:59:00Z',
      doing: WI('WI-1', 0),
      queued: [WI('WI-1', 0), WI('WI-2', 1)],
      load: 2,
      orphaned: false,
      claims: [{ type: 'work-item', harnessSlug: 'h', planSlug: null, id: 'WI-1', itemKind: 'feature', detail: 'd', status: 'wip', acquiredTs: null, expiresTs: null, active: true, orphaned: false, rank: 0, rankWriter: 'bee' }],
    });
    const p = pres({
      ownerId: 'su-x',
      ownerLabel: 'su · su-x',
      host: 'box1',
      agentRole: 'su',
      hiveSlug: 'papercup',
      lastActiveAt: '2026-06-14T03:59:30Z',
    });
    const [e] = foldHiveRoster([p], [a], tier1({ 'su-x': { claimedItems: ['P-006'], model: 'opus', awaitingEvent: true, awaitingEventKey: 'release:green' } }), NOW);
    // work-detail preserved verbatim
    expect(e.doing).toEqual(WI('WI-1', 0));
    expect(e.queued).toHaveLength(2);
    expect(e.load).toBe(2);
    expect(e.orphaned).toBe(false);
    expect(e.claims).toHaveLength(1);
    // presence + mig-277 scalars attached
    expect(e.agentRole).toBe('su');
    expect(e.hiveSlug).toBe('papercup');
    expect(e.host).toBe('box1');
    expect(e.lastActiveSecAgo).toBe(30); // 04:00:00 − 03:59:30
    // Tier-1 attached
    expect(e.claimedItems).toEqual(['P-006']);
    expect(e.model).toBe('opus');
    expect(e.awaitingEvent).toBe(true);
    expect(e.awaitingEventKey).toBe('release:green');
    expect(e.federated).toBe(false);
  });

  it('includes a presence-only idle agent (no assignment) with empty work-detail', () => {
    const p = pres({ ownerId: 'su-idle', ownerLabel: 'su · idle', stale: false, intent: 'thinking' });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW);
    expect(e.agentId).toBe('su-idle');
    expect(e.doing).toBeNull();
    expect(e.load).toBe(0);
    expect(e.alive).toBe(true); // from !stale
    expect(e.intent).toBe('thinking');
    expect(e.claimedItems).toEqual([]); // EMPTY_TIER1 default
  });

  it('folds a federated peer (presence-only) with the federated flag, no Tier-1', () => {
    const p = pres({ ownerId: 'fed:99@boxZ', ownerLabel: 'gh:99 · boxZ', hiveSlug: 'papercup', federated: true });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW);
    expect(e.federated).toBe(true);
    expect(e.ownerLabel).toBe('gh:99 · boxZ');
    expect(e.lastActiveSecAgo).toBeNull();
    expect(e.model).toBeNull();
  });

  it('keeps an assignment-only orphan (claim whose holder has no presence row)', () => {
    const a = asg({ agentId: 'su-gone', alive: false, orphaned: true, load: 1, doing: WI('WI-9') });
    const [e] = foldHiveRoster([], [a], tier1({}), NOW);
    expect(e.orphaned).toBe(true);
    expect(e.doing).toEqual(WI('WI-9'));
    expect(e.agentRole).toBeNull(); // no presence row
    expect(e.federated).toBe(false);
  });

  it('sorts live first, then orphan-holders, then newest heartbeat', () => {
    const out = foldHiveRoster(
      [
        pres({ ownerId: 'stale-old', stale: true, heartbeatAt: '2026-06-14T01:00:00Z' }),
        pres({ ownerId: 'live', stale: false, heartbeatAt: '2026-06-14T03:00:00Z' }),
        pres({ ownerId: 'stale-new', stale: true, heartbeatAt: '2026-06-14T03:30:00Z' }),
      ],
      [asg({ agentId: 'stale-old', alive: false, orphaned: true })],
      tier1({}),
      NOW,
    );
    // live first; among stale, orphan-holder (stale-old) before non-orphan (stale-new)
    expect(out.map((e) => e.agentId)).toEqual(['live', 'stale-old', 'stale-new']);
  });
});
