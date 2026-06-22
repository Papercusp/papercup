/**
 * bee-runs.test.ts — the live-execution view's PURE projection
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * idleReason / toBeeRun / summarizeBeeRuns are pure (deriveActivity over a fleet_assignment row +
 * the spec head), so they unit-test with synthetic rows and no PG. listBeeRuns (the I/O glue over
 * listFleetAssignments + the spec batch) is exercised by the integration suites.
 */
import { describe, expect, it } from 'vitest';
import { idleReason, toBeeRun, summarizeBeeRuns, type BeeRun, type RunningSpecHead } from './bee-runs';
import type { FleetAssignmentRow } from '../fleet/assignments';
import type { ItemActivity } from '../item-activity';

/** A live work-item-claim row, progressing by default; override per case. */
function row(over: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow {
  return {
    source: 'work_item_claim',
    agentId: 'su-bee',
    agentLabel: 'bee-1',
    harnessSlug: 'papercup',
    workItemId: 'F-1',
    itemId: 'F-1',
    itemKind: 'feature',
    detail: 'do the thing',
    status: 'wip',
    planSlug: 'plan-x',
    claimAcquiredTs: '2026-06-22T10:00:00.000Z',
    claimExpiresTs: '2026-06-22T10:05:00.000Z',
    holderHeartbeatAt: '2026-06-22T10:04:00.000Z',
    lastProgressAt: '2026-06-22T10:03:00.000Z',
    holderAlive: true,
    orphaned: false,
    stalled: false,
    ...over,
  } as unknown as FleetAssignmentRow;
}

describe('idleReason', () => {
  it('progressing + free have no reason; the rest explain the idle/blocked/reclaimable state', () => {
    expect(idleReason('progressing')).toBeNull();
    expect(idleReason('free')).toBeNull();
    expect(idleReason('alive')).toMatch(/grace window/);
    expect(idleReason('reserved')).toMatch(/liveness unknown/);
    expect(idleReason('stalled')).toMatch(/reclaimable/);
    expect(idleReason('dead')).toMatch(/orphaned/);
  });
});

describe('toBeeRun', () => {
  it('projects a fleet_assignment row + spec head into a BeeRun', () => {
    const spec: RunningSpecHead = { specId: 'spec-A', revision: 3 };
    expect(toBeeRun(row(), spec)).toMatchObject({
      bee: 'su-bee',
      beeLabel: 'bee-1',
      item: 'F-1',
      itemKind: 'feature',
      title: 'do the thing',
      status: 'wip',
      harness: 'papercup',
      plan: 'plan-x',
      claimedSince: '2026-06-22T10:00:00.000Z',
      leaseExpiresAt: '2026-06-22T10:05:00.000Z',
      heartbeatAt: '2026-06-22T10:04:00.000Z',
      lastProgressAt: '2026-06-22T10:03:00.000Z',
      activity: 'progressing',
      idleReason: null,
      spec,
    });
  });

  it('defaults the spec to null (no Queen-authored spec ⇒ DEFAULT ordering)', () => {
    expect(toBeeRun(row()).spec).toBeNull();
  });

  it('derives the activity (+ a matching idleReason) from the row liveness, agreeing with deriveActivity', () => {
    expect(toBeeRun(row({ holderAlive: true, lastProgressAt: null })).activity).toBe('alive');
    expect(toBeeRun(row({ holderAlive: false, lastProgressAt: null })).activity).toBe('reserved');
    expect(toBeeRun(row({ stalled: true })).activity).toBe('stalled'); // stalled wins over holderAlive
    const dead = toBeeRun(row({ orphaned: true })); // orphaned wins over everything
    expect(dead.activity).toBe('dead');
    expect(dead.idleReason).toMatch(/orphaned/);
    const reserved = toBeeRun(row({ holderAlive: false, lastProgressAt: null }));
    expect(reserved.idleReason).toMatch(/liveness unknown/);
  });

  it('falls back to empty strings when the row has no bee / item id', () => {
    const r = toBeeRun(row({ agentId: null, workItemId: null, itemId: null }));
    expect(r.bee).toBe('');
    expect(r.item).toBe('');
    expect(r.activity).toBe('free'); // no agentId ⇒ free
  });
});

describe('summarizeBeeRuns', () => {
  const mk = (activity: ItemActivity): BeeRun => ({ ...toBeeRun(row()), activity });

  it('rolls up by activity — alive + reserved both count as idle', () => {
    const runs = [mk('progressing'), mk('progressing'), mk('alive'), mk('reserved'), mk('stalled'), mk('dead')];
    expect(summarizeBeeRuns(runs)).toEqual({ total: 6, progressing: 2, idle: 2, stalled: 1, dead: 1 });
  });

  it('an empty run set rolls up to all-zero', () => {
    expect(summarizeBeeRuns([])).toEqual({ total: 0, progressing: 0, idle: 0, stalled: 0, dead: 0 });
  });
});
