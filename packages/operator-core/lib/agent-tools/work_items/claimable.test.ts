/**
 * claimable.test.ts — the work_items:claimable HANDLER (P-001,
 * claimable-read-tool-and-sql-encapsulation-audit-2026-07-21). The scheduler oracle
 * (aggregateIssueClaimExclusions), the row-lister (listIssueClaimableRows), the fleet
 * claim-spec resolver, and the caller-identity resolver are mocked; this pins the HANDLER's
 * own logic — filter assembly (spec ∧ kind), state/limit/spec threading, the returned
 * payload shape, breakdownOnly, and that it is READ-ONLY (never claims).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/claimable.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../scheduler/get-next', () => ({
  aggregateIssueClaimExclusions: vi.fn(),
  listIssueClaimableRows: vi.fn(),
  sampleIssueClaimExclusions: vi.fn(),
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: vi.fn(),
  listFleetClaimSpecCandidates: vi.fn(),
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'probe' }),
}));

import {
  aggregateIssueClaimExclusions,
  listIssueClaimableRows,
  sampleIssueClaimExclusions,
} from '../../scheduler/get-next';
import { resolveFleetClaimSpec, listFleetClaimSpecCandidates } from '../../scheduler/claim-spec-store';

const aggM = vi.mocked(aggregateIssueClaimExclusions);
const listM = vi.mocked(listIssueClaimableRows);
const sampleM = vi.mocked(sampleIssueClaimExclusions);
const recM = vi.mocked(resolveFleetClaimSpec);
const candM = vi.mocked(listFleetClaimSpecCandidates);

const tool = (await import('./claimable')).default;

const BREAKDOWN = {
  matchedByFilter: 9,
  claimable: 3,
  excluded: {
    taken: 2,
    claimHold: 1,
    needsHuman: 1,
    observationLane: 1,
    externalBlocker: 0,
    planLaneReserved: 1,
    federationDetector: 0,
    loopNoise: 0,
    alreadyCompleted: 1,
    crossMachineRig: 0,
    blockedDep: 0,
    cooldown: 0,
  },
};
const ROWS = [
  { id: 'WI-A', kind: 'bug', title: 'a', status: 'open', severity: 'minor', plan: null, featureOrder: null, createdTs: 1 },
  { id: 'WI-B', kind: 'change', title: 'b', status: 'open', severity: null, plan: 'p', featureOrder: 2, createdTs: 2 },
  { id: 'WI-C', kind: 'task', title: 'c', status: 'open', severity: null, plan: null, featureOrder: null, createdTs: 3 },
];

const run = async (args: unknown) => {
  const res = (await tool.handler(args as never, { ownerId: 'probe', workspaceId: 'ws-1' } as never)) as {
    content: { text: string }[];
  };
  return JSON.parse(res.content[0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  aggM.mockResolvedValue(BREAKDOWN as never);
  listM.mockResolvedValue(ROWS as never);
  sampleM.mockResolvedValue({} as never);
  recM.mockResolvedValue(null as never);
  candM.mockResolvedValue([] as never);
});

describe('work_items:claimable handler', () => {
  it('no spec/kind: reads the whole lane; claimableCount === oracle survivors; rows from the lister; default provenance', async () => {
    const out = await run({ harness: 'papercup' });
    // the oracle + lister were called with an EMPTY filter (whole issue-family lane), caller identity threaded.
    expect(aggM).toHaveBeenCalledWith(undefined, expect.objectContaining({ harness: 'papercup', assignee: 'probe' }));
    expect(listM).toHaveBeenCalledWith(undefined, expect.objectContaining({ harness: 'papercup', assignee: 'probe' }), 20);
    expect(out.claimableCount).toBe(3); // === breakdown.claimable (the authoritative number)
    expect(out.matchedByFilter).toBe(9);
    expect(out.returned).toBe(3);
    expect(out.claimable.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    expect(out.excludedBreakdown.taken).toBe(2);
    expect(out.spec).toEqual({ specId: 'default-fixed-ordering', revision: 0, source: 'default' });
    // NEVER claims — no spec record was resolved and no claim mock exists.
    expect(recM).not.toHaveBeenCalled();
  });

  it('a single kind narrows the filter to a `= kind` leaf', async () => {
    await run({ harness: 'papercup', kind: 'bug' });
    expect(aggM.mock.calls[0]![0]).toEqual({ field: 'kind', op: '=', value: 'bug' });
    expect(listM.mock.calls[0]![0]).toEqual({ field: 'kind', op: '=', value: 'bug' });
  });

  it('multiple kinds narrow the filter to an `in [kinds]` leaf', async () => {
    await run({ harness: 'papercup', kind: ['bug', 'task'] });
    expect(aggM.mock.calls[0]![0]).toEqual({ field: 'kind', op: 'in', value: ['bug', 'task'] });
  });

  it('a fleet spec (by SLUG) scopes the lane by its filter/states/rank + reports its provenance', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'myfleet',
      matchedBy: 'fleet-slug',
      record: {
        source: 'fleet',
        spec: { specId: 'bug-drain', revision: 4, view: { filter: { field: 'plan', op: '=', value: 'x' } }, states: ['open'] },
        revision: 4,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'myfleet',
      },
    } as never);
    const out = await run({ harness: 'papercup', spec: 'myfleet' });
    // resolved via the shared fleet/specId resolver under the caller's claim-spec workspace.
    expect(recM).toHaveBeenCalledWith({ spec: 'myfleet', workspaceId: 'ws-1' });
    // the spec's own filter scopes the oracle + lister; the spec + its states ride through.
    expect(aggM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'x' });
    expect(aggM.mock.calls[0]![1]).toEqual(expect.objectContaining({ states: ['open'] }));
    expect(listM.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ spec: expect.objectContaining({ specId: 'bug-drain' }) }),
    );
    expect(out.spec).toEqual({
      specId: 'bug-drain',
      revision: 4,
      source: 'fleet',
      fleetSlug: 'myfleet',
      matchedBy: 'fleet-slug',
    });
  });

  it('a fleet spec resolved by its own specId (not the fleet slug) still scopes the lane + reports matchedBy', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'p2p-release',
      matchedBy: 'spec-id',
      record: {
        source: 'fleet',
        spec: { specId: 'p2p-release-lane', revision: 12, view: { filter: { field: 'plan', op: '=', value: 'y' } }, states: ['open'] },
        revision: 12,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'p2p-release',
      },
    } as never);
    const out = await run({ harness: 'papercup', spec: 'p2p-release-lane' });
    expect(recM).toHaveBeenCalledWith({ spec: 'p2p-release-lane', workspaceId: 'ws-1' });
    expect(aggM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'y' });
    expect(out.spec).toEqual({
      specId: 'p2p-release-lane',
      revision: 12,
      source: 'fleet',
      fleetSlug: 'p2p-release',
      matchedBy: 'spec-id',
    });
  });

  it('an unrecognized `spec` (neither namespace matches) ERRORS with candidates — never falls back to the whole backlog', async () => {
    recM.mockResolvedValue(null as never);
    candM.mockResolvedValue([{ fleetSlug: 'p2p-release', specId: 'p2p-release-lane', revision: 12 }] as never);
    const out = await run({ harness: 'papercup', spec: 'bogus-spec' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no fleet or claim-spec named 'bogus-spec'/);
    expect(out.candidates).toEqual([{ fleetSlug: 'p2p-release', specId: 'p2p-release-lane', revision: 12 }]);
    // never widened to the unfiltered lane — the oracle/lister were never even called.
    expect(aggM).not.toHaveBeenCalled();
    expect(listM).not.toHaveBeenCalled();
  });

  it('spec ∧ kind AND-combine into one filter tree', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'f',
      matchedBy: 'fleet-slug',
      record: {
        source: 'fleet',
        spec: { specId: 's', revision: 1, view: { filter: { field: 'plan', op: '=', value: 'x' } }, states: ['open'] },
        revision: 1,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'f',
      },
    } as never);
    await run({ harness: 'papercup', spec: 'f', kind: 'bug' });
    expect(aggM.mock.calls[0]![0]).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'x' },
        { field: 'kind', op: '=', value: 'bug' },
      ],
    });
  });

  it('breakdownOnly skips the row lister entirely and returns an empty list + the count', async () => {
    const out = await run({ harness: 'papercup', breakdownOnly: true });
    expect(listM).not.toHaveBeenCalled();
    expect(out.claimable).toEqual([]);
    expect(out.returned).toBe(0);
    expect(out.claimableCount).toBe(3); // the count still comes from the oracle
  });

  it('threads explicit states + limit through to both primitives', async () => {
    await run({ harness: 'papercup', states: ['open', 'failing'], limit: 5 });
    expect(aggM.mock.calls[0]![1]).toEqual(expect.objectContaining({ states: ['open', 'failing'] }));
    expect(listM.mock.calls[0]![1]).toEqual(expect.objectContaining({ states: ['open', 'failing'] }));
    expect(listM.mock.calls[0]![2]).toBe(5);
  });

  it('omitting sampleExcluded skips the sampler entirely and omits excludedSample from the payload', async () => {
    const out = await run({ harness: 'papercup' });
    expect(sampleM).not.toHaveBeenCalled();
    expect(out.excludedSample).toBeUndefined();
  });

  it('sampleExcluded calls the sampler with the same filter/harness/states/assignee + the given limit, and surfaces excludedSample', async () => {
    sampleM.mockResolvedValue({
      taken: ['WI-1', 'WI-2'],
      claimHold: ['WI-3'],
      needsHuman: [],
      observationLane: [],
      externalBlocker: [],
      planLaneReserved: [],
      federationDetector: [],
      loopNoise: [],
      alreadyCompleted: [],
      crossMachineRig: [],
      blockedDep: [],
      cooldown: [],
    } as never);
    const out = await run({ harness: 'papercup', kind: 'bug', sampleExcluded: 5 });
    expect(sampleM).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      5,
    );
    expect(out.excludedSample.taken).toEqual(['WI-1', 'WI-2']);
    expect(out.excludedSample.claimHold).toEqual(['WI-3']);
  });
});
