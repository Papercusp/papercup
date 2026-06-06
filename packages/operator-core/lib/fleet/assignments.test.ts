/**
 * assignments.test.ts — the pure by-agent grouping + smell selectors over
 * fleet_assignment rows (state-not-chat-fleet-state-2026-06-05, P-002).
 *
 * The load-bearing invariant under test is CLAIM-PRIMARY (D-002): a claim whose
 * holder has no presence row must still produce an agent group (orphan), not be
 * silently dropped the way a presence-primary join would.
 */
import { describe, expect, it } from 'vitest';
import {
  groupByAgent,
  orphanedClaims,
  type FleetAssignmentRow,
} from './assignments';

const base: FleetAssignmentRow = {
  source: 'presence',
  workspaceId: '*',
  agentId: 'su-a',
  agentLabel: 'su · a',
  agentName: null,
  harnessSlug: null,
  planSlug: null,
  itemId: null,
  workItemId: null,
  itemKind: null,
  detail: '',
  status: null,
  claimAcquiredTs: null,
  claimExpiresTs: null,
  claimActive: null,
  livenessMode: null,
  lastActivityTs: null,
  holderPresent: true,
  holderAlive: true,
  holderHeartbeatAt: '2026-06-05T12:00:00.000Z',
  holderIntent: null,
  holderPlanSlug: null,
  orphaned: false,
  declaredPlanMatches: null,
  assigneeRank: null,
  rankWriter: null,
};

const presence = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  ...over,
});

const planClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'plan_item_claim',
  planSlug: 'plan-x',
  itemId: 'P-001',
  harnessSlug: 'all',
  claimActive: true,
  ...over,
});

describe('groupByAgent — claim-primary (D-002)', () => {
  it('a claim with NO presence row still yields an agent group (the orphan survives)', () => {
    const groups = groupByAgent([
      planClaim({
        agentId: 'su-dead',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-dead');
    expect(groups[0].present).toBe(false);
    expect(groups[0].alive).toBe(false);
    expect(groups[0].orphaned).toBe(true);
    expect(groups[0].claims).toHaveLength(1);
  });

  it('merges a presence row and its claims into one group', () => {
    const groups = groupByAgent([
      presence({ detail: 'building x', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-a', detail: 'P-001 work' }),
      planClaim({
        agentId: 'su-a',
        source: 'work_item_claim',
        itemId: null,
        workItemId: 'WI-7',
        itemKind: 'task',
        planSlug: null,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.present).toBe(true);
    expect(g.intent).toBe('building x');
    expect(g.declaredPlanSlug).toBe('plan-x');
    expect(g.claims).toHaveLength(2);
    expect(g.claims.map((c) => c.type).sort()).toEqual(['plan-item', 'work-item']);
  });

  it('name-keyed assignment rows merge into the owner group that claims that name', () => {
    const groups = groupByAgent([
      planClaim({ agentId: 'su-a', agentName: 'builder-1' }),
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-1',
        agentName: 'builder-1',
        planSlug: 'plan-x',
        itemId: 'P-002',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-a');
    expect(groups[0].name).toBe('builder-1');
    expect(groups[0].claims).toHaveLength(2);
  });

  it('an assignment whose name no claim links stays a standalone name-keyed group', () => {
    const groups = groupByAgent([
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-9',
        agentName: 'builder-9',
        planSlug: 'plan-y',
        itemId: 'P-003',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('builder-9');
    expect(groups[0].present).toBe(false);
  });

  it('flags declaredUnclaimed when the declared plan is backed by no claim (the D-002 smell)', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-smell', planSlug: 'plan-z' }),
      presence({ agentId: 'su-ok', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-ok' }),
    ]);
    const smell = groups.find((g) => g.agentId === 'su-smell');
    const ok = groups.find((g) => g.agentId === 'su-ok');
    expect(smell?.declaredUnclaimed).toBe(true);
    expect(ok?.declaredUnclaimed).toBe(false);
  });

  it('sorts live agents first, then orphan-holders', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-stale', holderAlive: false, holderHeartbeatAt: '2026-06-05T01:00:00.000Z' }),
      planClaim({ agentId: 'su-orphan', holderPresent: false, holderAlive: false, holderHeartbeatAt: null, orphaned: true }),
      presence({ agentId: 'su-live' }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(['su-live', 'su-orphan', 'su-stale']);
  });
});

// The work-item-claim row factory carrying a per-assignee rank (local-hive P-021).
const workClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'work_item_claim',
  agentId: 'su-bee',
  itemId: null,
  workItemId: 'WI-?',
  itemKind: 'feature',
  detail: 'a work-item',
  status: 'todo',
  claimActive: true,
  ...over,
});

describe('groupByAgent — the per-bee ordered work-list (local-hive P-021)', () => {
  it('derives doing (head-of-line) + queued (rank order) + load from work-item claims', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee', detail: 'working' }),
      workClaim({ workItemId: 'WI-3', detail: 'third', assigneeRank: 2, rankWriter: 'bee' }),
      workClaim({ workItemId: 'WI-1', detail: 'first', assigneeRank: 0, rankWriter: 'queen' }),
      workClaim({ workItemId: 'WI-2', detail: 'second', assigneeRank: 1, rankWriter: 'bee' }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.load).toBe(3);
    expect(g.queued.map((q) => q.id)).toEqual(['WI-1', 'WI-2', 'WI-3']); // rank ASC
    expect(g.doing?.id).toBe('WI-1'); // head-of-line = lowest rank
    expect(g.doing?.rankWriter).toBe('queen'); // the Queen-overlaid head
  });

  it('sorts unranked work-items to the tail (NULLs last), stable by id', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee' }),
      workClaim({ workItemId: 'WI-b', assigneeRank: null }),
      workClaim({ workItemId: 'WI-a', assigneeRank: null }),
      workClaim({ workItemId: 'WI-ranked', assigneeRank: 0 }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.queued.map((q) => q.id)).toEqual(['WI-ranked', 'WI-a', 'WI-b']);
    expect(g.doing?.id).toBe('WI-ranked');
  });

  it('an agent with no work-items has doing=null, queued=[], load=0', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-idle' }),
      planClaim({ agentId: 'su-idle' }), // a plan-item lease is NOT a work-item
    ]);
    const g = groups.find((x) => x.agentId === 'su-idle')!;
    expect(g.doing).toBeNull();
    expect(g.queued).toEqual([]);
    expect(g.load).toBe(0);
  });
});

describe('orphanedClaims', () => {
  it('keeps active orphaned claims, drops lapsed and held ones', () => {
    const rows = [
      planClaim({ agentId: 'su-1', orphaned: true, claimActive: true }),
      planClaim({ agentId: 'su-2', orphaned: true, claimActive: false }), // lapsed
      planClaim({ agentId: 'su-3', orphaned: false, claimActive: true }), // healthy
    ];
    expect(orphanedClaims(rows).map((r) => r.agentId)).toEqual(['su-1']);
  });
});
