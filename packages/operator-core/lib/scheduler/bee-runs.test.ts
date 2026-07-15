/**
 * bee-runs.test.ts — the live-execution view's PURE projection
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * idleReason / toBeeRun / summarizeBeeRuns are pure (deriveActivity over a fleet_assignment row +
 * the spec head), so they unit-test with synthetic rows and no PG. listBeeRuns (the I/O glue over
 * listFleetAssignments + the spec batch) is exercised by the integration suites.
 */
import { describe, expect, it, vi } from 'vitest';

// listBeeRuns is thin I/O glue — mock its two collaborators (the real deriveActivity is kept so
// toBeeRun's projection stays under test) to exercise the filter + dedup + spec-join in isolation.
vi.mock('../fleet/assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fleet/assignments')>();
  return { ...actual, listFleetAssignments: vi.fn() };
});
vi.mock('./claim-spec-store', () => ({ getClaimSpecHeadsForBees: vi.fn() }));

import {
  idleReason,
  toBeeRun,
  summarizeBeeRuns,
  listBeeRuns,
  applyHealthyLoopExemption,
  type BeeRun,
  type RunningSpecHead,
} from './bee-runs';
import { listFleetAssignments } from '../fleet/assignments';
import { getClaimSpecHeadsForBees } from './claim-spec-store';
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

describe('applyHealthyLoopExemption (EI-12359 — parity with fleet:assignments\' loop-monitor exemption)', () => {
  const mk = (activity: ItemActivity, bee = 'su-bee'): BeeRun => ({ ...toBeeRun(row({ agentId: bee })), activity });

  it('downgrades a stalled run to alive when its bee is in the healthy-monitor set', () => {
    const runs = [mk('stalled', 'su-batch')];
    const out = applyHealthyLoopExemption(runs, new Set(['su-batch']));
    expect(out[0].activity).toBe('alive');
    expect(out[0].idleReason).toMatch(/grace window/); // re-derived via idleReason('alive')
  });

  it('leaves a stalled run alone when its bee is NOT in the healthy-monitor set', () => {
    const runs = [mk('stalled', 'su-lonely')];
    const out = applyHealthyLoopExemption(runs, new Set(['su-other']));
    expect(out[0].activity).toBe('stalled');
    expect(out[0].idleReason).toBe(runs[0].idleReason);
  });

  it('never touches a non-stalled run, even for a healthy-monitor bee (progressing/alive/reserved/dead pass through unchanged)', () => {
    const runs = [mk('progressing', 'su-batch'), mk('alive', 'su-batch'), mk('reserved', 'su-batch'), mk('dead', 'su-batch')];
    const out = applyHealthyLoopExemption(runs, new Set(['su-batch']));
    expect(out).toEqual(runs);
  });

  it('a bee holding many items (batch claim): only the stalled ones flip, and only for a healthy bee', () => {
    const runs = [
      mk('stalled', 'su-batch'), // item 1: not yet touched — false-alarm stalled
      mk('progressing', 'su-batch'), // item 2: the one actively being worked
      mk('stalled', 'su-cold'), // a different, genuinely-idle bee (not in the healthy set)
    ];
    const out = applyHealthyLoopExemption(runs, new Set(['su-batch']));
    expect(out.map((r) => r.activity)).toEqual(['alive', 'progressing', 'stalled']);
  });

  it('an empty healthy-monitor set is a no-op', () => {
    const runs = [mk('stalled')];
    expect(applyHealthyLoopExemption(runs, new Set())).toEqual(runs);
  });

  it('a run with no bee id is never matched, even against an all-inclusive-looking set', () => {
    const runs = [mk('stalled', '')];
    const out = applyHealthyLoopExemption(runs, new Set(['']));
    expect(out[0].activity).toBe('stalled'); // falsy bee id guard — never exempted
  });
});

describe('listBeeRuns (I/O glue over fleet_assignment + the spec batch)', () => {
  const mockList = vi.mocked(listFleetAssignments);
  const mockSpecs = vi.mocked(getClaimSpecHeadsForBees);

  it('keeps only live work-item-claims (with an item), and joins each bee\'s spec head', async () => {
    mockList.mockResolvedValue([
      row({ source: 'work_item_claim', agentId: 'su-a', workItemId: 'F-1' }),
      row({ source: 'work_item_claim', agentId: 'su-b', workItemId: 'F-2' }),
      row({ source: 'plan_item_claim', agentId: 'su-c', workItemId: 'P-1' }), // a plan-item claim, not a work-item claim → dropped
      row({ source: 'work_item_claim', agentId: 'su-d', workItemId: null }), // claim w/o an item → excluded
      row({ source: 'presence', agentId: 'su-e', workItemId: null }), // presence row, not a claim
    ] as FleetAssignmentRow[]);
    mockSpecs.mockResolvedValue(new Map([['su-a', { specId: 'spec-A', revision: 2 }]]));

    const runs = await listBeeRuns({ harness: 'papercup', workspaceId: 'ws-1' });

    expect(runs.map((r) => r.item)).toEqual(['F-1', 'F-2']); // leases / presence / item-less claims dropped
    expect(runs.find((r) => r.bee === 'su-a')!.spec).toEqual({ specId: 'spec-A', revision: 2 });
    expect(runs.find((r) => r.bee === 'su-b')!.spec).toBeNull(); // no stored spec → null (DEFAULT ordering)
    expect(mockSpecs).toHaveBeenCalledWith(['su-a', 'su-b'], 'ws-1'); // deduped bee set, workspace-scoped
  });

  it('returns [] when there are no live claims', async () => {
    mockList.mockResolvedValue([]);
    mockSpecs.mockResolvedValue(new Map());
    expect(await listBeeRuns({ workspaceId: 'ws-1' })).toEqual([]);
  });
});
