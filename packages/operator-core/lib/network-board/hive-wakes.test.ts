// hive-wakes pure filter (hive-network-surface-2026-06-11 P-014 item 3,
// D-007 GAP 1): owner→hive attribution from fleet rows + the staged-wake
// queue scoped to one hive. No PG — fixtures in, rows out.

import { describe, expect, it } from 'vitest';
import type { PendingWake } from '../agent-tools/coordination/pending-wakes';
import type { FleetAssignmentRow } from '../fleet/assignments';
import { filterWakesToHive, hiveOwnerIds } from './hive-wakes';

function fleetRow(over: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow {
  return {
    source: 'presence',
    workspaceId: 'ws',
    agentId: 'su-a',
    agentLabel: null,
    agentName: null,
    harnessSlug: 'hive-x',
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
    holderHeartbeatAt: null,
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    stalled: null,
    lastProgressAt: null,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    ...over,
  };
}

function wake(ownerId: string, over: Partial<PendingWake> = {}): PendingWake {
  return {
    id: 1,
    ownerId,
    summary: null,
    payload: null,
    source: null,
    workspaceId: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    count: 1,
    lastSeenAt: '2026-06-12T00:00:00.000Z',
    ...over,
  };
}

describe('hiveOwnerIds', () => {
  it('collects distinct owner ids attributed to the hive, across presence and claim rows', () => {
    const rows = [
      fleetRow({ agentId: 'su-a' }),
      fleetRow({ agentId: 'su-a', source: 'plan_item_claim' }), // dup owner, second source
      fleetRow({ agentId: 'su-b' }),
      fleetRow({ agentId: 'su-other', harnessSlug: 'hive-y' }),
    ];
    expect([...hiveOwnerIds(rows, 'hive-x')].sort()).toEqual(['su-a', 'su-b']);
  });

  it('keeps a STALE holder — a manual-mode paused agent is exactly whose wakes get reviewed', () => {
    const rows = [fleetRow({ agentId: 'su-paused', holderAlive: false })];
    expect(hiveOwnerIds(rows, 'hive-x').has('su-paused')).toBe(true);
  });

  it('skips rows without an agent id or hive attribution', () => {
    const rows = [fleetRow({ agentId: null }), fleetRow({ harnessSlug: null })];
    expect(hiveOwnerIds(rows, 'hive-x').size).toBe(0);
  });
});

describe('filterWakesToHive', () => {
  it('returns only wakes whose owner is attributed to the hive, preserving input order', () => {
    const rows = [fleetRow({ agentId: 'su-a' }), fleetRow({ agentId: 'su-b' })];
    const wakes = [
      wake('su-a', { id: 1 }),
      wake('su-elsewhere', { id: 2 }),
      wake('su-b', { id: 3 }),
      wake('su-a', { id: 4 }),
    ];
    expect(filterWakesToHive(wakes, rows, 'hive-x').map((w) => w.id)).toEqual([1, 3, 4]);
  });

  it('drops wakes for owners with NO fleet row (no hive attribution — fleet-wide board stays the whole truth)', () => {
    expect(filterWakesToHive([wake('su-gone')], [], 'hive-x')).toEqual([]);
  });
});
