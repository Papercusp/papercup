/**
 * claimable.test.ts — the work_items:claimable HANDLER (P-001,
 * claimable-read-tool-and-sql-encapsulation-audit-2026-07-21). The single-snapshot
 * claimability read (readIssueClaimability), the fleet claim-spec resolver, and the
 * caller-identity resolver are mocked; this pins the HANDLER's own logic — filter assembly
 * (spec ∧ kind), state/limit/spec threading, the returned payload shape, breakdownOnly, and
 * that it is READ-ONLY (never claims).
 *
 * WI-5947: the handler used to issue THREE independent reads (counts, rows, sample) and
 * present them as one verdict. It now makes exactly ONE call to readIssueClaimability,
 * which reads all three inside one REPEATABLE READ snapshot — pinned below.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/claimable.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: vi.fn(),
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: vi.fn(),
  listFleetClaimSpecCandidates: vi.fn(),
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));
const hiveMocks = vi.hoisted(() => ({ potHomeSlugForHarness: vi.fn() }));
vi.mock('../../hive-federation', () => hiveMocks);
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'probe' }),
}));

import { readIssueClaimability } from '../../scheduler/get-next';
import { resolveFleetClaimSpec, listFleetClaimSpecCandidates } from '../../scheduler/claim-spec-store';

const readM = vi.mocked(readIssueClaimability);
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
    remoteOrigin: 0,
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

const EMPTY_SAMPLE = {
  taken: [],
  claimHold: [],
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
};
/** What the mocked snapshot read reports as its per-floor sample (a test may override). */
let sampleValue: Record<string, string[]> = EMPTY_SAMPLE;

/**
 * A HEALTHY admitted composition (WI-6673) — the default, so the composition warning is
 * off unless a test opts into the degenerate shape. `admitted` is a REQUIRED field of
 * IssueClaimabilityReading; this fixture went stale when it was added and took all 11
 * tests in this file down with a `Cannot read properties of undefined` — invisible to tsc
 * because the mock is cast `as never`. If you add another field to that interface, add it
 * here too.
 */
const HEALTHY_ADMITTED = {
  total: 3,
  byKind: { bug: 2, change: 1 },
  bySeverity: { major: 2, minor: 1 },
  lowSeverityShare: 1 / 3,
  degenerate: false,
  peakDay: { day: '2026-08-01', count: 3 },
};
/** What the mocked snapshot read reports as the admitted composition (a test may override). */
let admittedValue: Record<string, unknown> = HEALTHY_ADMITTED;

beforeEach(() => {
  vi.clearAllMocks();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  sampleValue = EMPTY_SAMPLE;
  admittedValue = HEALTHY_ADMITTED;
  // Stands in for the ONE snapshot read: honours breakdownOnly/sampleLimit exactly as the
  // real readIssueClaimability does, so the handler's payload assembly is what's under test.
  readM.mockImplementation((async (_filter: unknown, _opts: unknown, readOpts: { breakdownOnly?: boolean; sampleLimit?: number }) => ({
    breakdown: BREAKDOWN,
    rows: readOpts.breakdownOnly ? [] : ROWS,
    admitted: admittedValue,
    ...(readOpts.sampleLimit ? { sample: sampleValue } : {}),
  })) as never);
  recM.mockResolvedValue(null as never);
  candM.mockResolvedValue([] as never);
});

describe('work_items:claimable handler', () => {
  it('resolves member harnesses to their Hive home and discloses both scopes', async () => {
    hiveMocks.potHomeSlugForHarness.mockResolvedValue('oddsmith-hive');

    const out = await run({ harness: 'oddsmith' });

    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-1', 'oddsmith');
    expect(readM.mock.calls[0]![1]).toEqual(expect.objectContaining({ harness: 'oddsmith-hive' }));
    expect(out.harness).toBe('oddsmith-hive');
    expect(out.claimableHarnessScope).toEqual({
      requested: 'oddsmith',
      resolved: 'oddsmith-hive',
      resolution: 'hive-home',
    });
  });

  it('no spec/kind: reads the whole lane; claimableCount === oracle survivors; rows from the lister; default provenance', async () => {
    const out = await run({ harness: 'papercup' });
    // the snapshot read was called with an EMPTY filter (whole issue-family lane), caller identity threaded.
    expect(readM).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      expect.objectContaining({ limit: 20 }),
    );
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
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'kind', op: '=', value: 'bug' });
  });

  it('multiple kinds narrow the filter to an `in [kinds]` leaf', async () => {
    await run({ harness: 'papercup', kind: ['bug', 'task'] });
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'kind', op: 'in', value: ['bug', 'task'] });
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
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'x' });
    expect(readM.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ states: ['open'], spec: expect.objectContaining({ specId: 'bug-drain' }) }),
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
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'y' });
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
    // never widened to the unfiltered lane — the snapshot read was never even issued.
    expect(readM).not.toHaveBeenCalled();
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
    expect(readM.mock.calls[0]![0]).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'x' },
        { field: 'kind', op: '=', value: 'bug' },
      ],
    });
  });

  it('breakdownOnly skips the row lister entirely and returns an empty list + the count', async () => {
    const out = await run({ harness: 'papercup', breakdownOnly: true });
    expect(readM.mock.calls[0]![2]).toEqual(expect.objectContaining({ breakdownOnly: true }));
    expect(out.claimable).toEqual([]);
    expect(out.returned).toBe(0);
    expect(out.claimableCount).toBe(3); // the count still comes from the oracle
  });

  it('threads explicit states + limit through to both primitives', async () => {
    await run({ harness: 'papercup', states: ['open', 'failing'], limit: 5 });
    expect(readM.mock.calls[0]![1]).toEqual(expect.objectContaining({ states: ['open', 'failing'] }));
    expect(readM.mock.calls[0]![2]).toEqual(expect.objectContaining({ limit: 5 }));
  });

  describe('WI-6673: admittedBreakdown + the composition warning', () => {
    it('surfaces admittedBreakdown UNCONDITIONALLY — no opt-in flag, because the failure is quoting a count without asking what is in it', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.admittedBreakdown).toEqual(HEALTHY_ADMITTED);
    });

    it('is present under breakdownOnly too — the cheap read is exactly where a caller quotes a bare number', async () => {
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      expect(out.admittedBreakdown).toEqual(HEALTHY_ADMITTED);
    });

    it('a HEALTHY pool gets NO composition warning — a warning that cries wolf is ignored when it matters', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.note).not.toMatch(/COMPOSITION WARNING/);
      expect(out.note).toMatch(/authoritative claimable total/); // the base note still lands
    });

    it('a DEGENERATE pool appends the warning, naming the share, the burst day and the item id', async () => {
      admittedValue = {
        total: 12_564,
        byKind: { change: 12_564 },
        bySeverity: { nit: 11_584, minor: 980 },
        lowSeverityShare: 0.987,
        degenerate: true,
        peakDay: { day: '2026-07-31', count: 9_312 },
      };
      const out = await run({ harness: 'papercup' });
      expect(out.note).toMatch(/⚠ COMPOSITION WARNING/);
      expect(out.note).toContain('99% of this lane is nit/minor severity'); // 0.987 → rounded
      expect(out.note).toContain('9312 of it was filed on a single day (2026-07-31)');
      expect(out.note).toContain('is NOT a workload');
      expect(out.note).toContain('WI-6673');
    });

    it('a degenerate pool with no peakDay still warns — the day clause is optional, the warning is not', async () => {
      admittedValue = {
        total: 900,
        byKind: { change: 900 },
        bySeverity: { nit: 900 },
        lowSeverityShare: 1,
        degenerate: true,
        peakDay: null,
      };
      const out = await run({ harness: 'papercup' });
      expect(out.note).toMatch(/⚠ COMPOSITION WARNING/);
      expect(out.note).toContain('100% of this lane is nit/minor severity');
      expect(out.note).not.toContain('filed on a single day');
    });

    it('the warning rides on `note`, where a caller reading the count cannot miss it — not a field they must know to ask for', async () => {
      admittedValue = { ...HEALTHY_ADMITTED, degenerate: true, lowSeverityShare: 0.91, peakDay: null };
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      // Same read that returns claimableCount carries the caveat about claimableCount.
      expect(out.claimableCount).toBe(3);
      expect(out.note).toMatch(/COMPOSITION WARNING/);
    });
  });

  it('omitting sampleExcluded skips the sampler entirely and omits excludedSample from the payload', async () => {
    const out = await run({ harness: 'papercup' });
    expect(readM.mock.calls[0]![2]!.sampleLimit).toBeUndefined();
    expect(out.excludedSample).toBeUndefined();
  });

  it('sampleExcluded rides through as sampleLimit on the SAME snapshot read + surfaces excludedSample', async () => {
    sampleValue = { ...EMPTY_SAMPLE, taken: ['WI-1', 'WI-2'], claimHold: ['WI-3'] };
    const out = await run({ harness: 'papercup', kind: 'bug', sampleExcluded: 5 });
    expect(readM).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      expect.objectContaining({ sampleLimit: 5 }),
    );
    expect(out.excludedSample.taken).toEqual(['WI-1', 'WI-2']);
    expect(out.excludedSample.claimHold).toEqual(['WI-3']);
  });

  it('WI-5947: the counts, the rows and the sample come from ONE read — the handler never issues them separately', async () => {
    await run({ harness: 'papercup', sampleExcluded: 3 });
    // Three independent round-trips presented as one verdict is the defect; one call is the fix.
    expect(readM).toHaveBeenCalledTimes(1);
  });

  describe('EI-18835176695181727: rows/count aliases', () => {
    it('exposes `rows` as an alias of `claimable` and `count` as an alias of `claimableCount`', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.rows).toEqual(out.claimable);
      expect(out.count).toBe(out.claimableCount);
      expect(out.count).toBe(3);
      expect(out.rows.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    });

    it('the aliases stay correct under breakdownOnly (empty rows, count still the oracle total)', async () => {
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      expect(out.rows).toEqual([]);
      expect(out.count).toBe(3);
    });
  });
});
