/**
 * running.test.ts — the scheduler:running HANDLER (the live-execution view of BEE RUNS)
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * Drives the tool handler end-to-end over a SEEDED running bee, asserting the view surfaces
 * the five P-001 fields together — current item, claim-spec specId@revision, progress
 * (lastProgressAt), lease/heartbeat, and the derived idle/blocked reason — through the REAL
 * listBeeRuns → toBeeRun projection. The seam is the live-state boundary (listFleetAssignments
 * + the per-bee spec batch); the projection (deriveActivity/idleReason/the spec-join) runs for
 * real, so this catches a regression that drops a field, mis-joins the spec, or reads off a
 * separate store instead of the canonical fleet_assignment view.
 *
 * Sibling of bee-runs.test.ts (the pure projection in isolation): this pins the TOOL wiring —
 * identity-soft-resolve → workspace scope → listBeeRuns → the { ok, summary, runs } envelope.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/scheduler/running.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two live-state collaborators behind listBeeRuns; keep the real deriveActivity so the
// idle/blocked reason is derived (not stubbed) from the seeded row's liveness.
vi.mock('../../fleet/assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/assignments')>();
  return { ...actual, listFleetAssignments: vi.fn() };
});
vi.mock('../../scheduler/claim-spec-store', () => ({ getClaimSpecHeadsForBees: vi.fn() }));

import { listFleetAssignments, type FleetAssignmentRow } from '../../fleet/assignments';
import { getClaimSpecHeadsForBees } from '../../scheduler/claim-spec-store';

const mockList = vi.mocked(listFleetAssignments);
const mockSpecs = vi.mocked(getClaimSpecHeadsForBees);
const tool = (await import('./running')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const body = (o: Out) =>
  JSON.parse(o.content[0]!.text) as {
    ok: boolean;
    summary: { total: number; progressing: number; idle: number; stalled: number; dead: number };
    runs: Array<Record<string, unknown>>;
  };
// The handler resolves identity only to DEFAULT the workspace, softly (try/catch). Passing
// { workspace } pins the scope, so a bare ctx is fine.
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ workspace: 'ws-1', ...args } as never, {} as never) as Promise<Out>;

/** A live work-item-claim row, progressing by default; override per case. */
function row(over: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow {
  return {
    source: 'work_item_claim',
    agentId: 'su-bee',
    agentLabel: 'bee-1',
    harnessSlug: 'papercup',
    workItemId: 'F-42',
    itemId: 'F-42',
    itemKind: 'feature',
    detail: 'wire the resolver',
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

beforeEach(() => {
  vi.clearAllMocks();
  mockSpecs.mockResolvedValue(new Map());
});

describe('scheduler:running handler — the live-execution view', () => {
  it('surfaces a seeded running cup: current item + spec specId@revision + progress + lease/heartbeat + idle reason', async () => {
    // A bee mid-run, no item-scoped progress yet (grace window) → an idle/blocked reason, under
    // a Queen-authored spec at revision 7.
    mockList.mockResolvedValue([row({ lastProgressAt: null })] as FleetAssignmentRow[]);
    mockSpecs.mockResolvedValue(new Map([['su-bee', { specId: 'queen-spec', revision: 7 }]]));

    const out = await call();
    expect(out.isError).toBeUndefined();
    const { ok, summary, runs } = body(out);

    expect(ok).toBe(true);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    // current claimed work-item (the bee + the item it is running)
    expect(run).toMatchObject({ cup: 'su-bee', item: 'F-42', title: 'wire the resolver', status: 'wip' });
    // claim-spec specId@revision the bee runs under
    expect(run.spec).toEqual({ specId: 'queen-spec', revision: 7 });
    // lease / heartbeat
    expect(run.leaseExpiresAt).toBe('2026-06-22T10:05:00.000Z');
    expect(run.heartbeatAt).toBe('2026-06-22T10:04:00.000Z');
    // progress + the DERIVED idle/blocked reason (alive, no item progress yet)
    expect(run.lastProgressAt).toBeNull();
    expect(run.activity).toBe('alive');
    expect(run.idleReason).toMatch(/no item progress recorded yet/);
    // summary header rolls the run up as idle (claimed, not yet progressing)
    expect(summary).toMatchObject({ total: 1, progressing: 0, idle: 1 });

    // read off the LIVE state, workspace-scoped — not a separate store
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', activeOnly: true }),
    );
    expect(mockSpecs).toHaveBeenCalledWith(['su-bee'], 'ws-1');
  });

  it('a progressing bee with no Queen-authored spec reports spec=null (DEFAULT ordering) and no idle reason', async () => {
    mockList.mockResolvedValue([row()] as FleetAssignmentRow[]); // progressing (lastProgressAt set)
    mockSpecs.mockResolvedValue(new Map()); // no stored spec for this bee

    const { runs, summary } = body(await call());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.spec).toBeNull(); // DEFAULT ordering
    expect(runs[0]!.activity).toBe('progressing');
    expect(runs[0]!.idleReason).toBeNull();
    expect(runs[0]!.lastProgressAt).toBe('2026-06-22T10:03:00.000Z');
    expect(summary).toMatchObject({ total: 1, progressing: 1, idle: 0 });
  });

  it('a stalled bee surfaces the reclaimable idle/blocked reason in the run + summary', async () => {
    mockList.mockResolvedValue([row({ stalled: true })] as FleetAssignmentRow[]);

    const { runs, summary } = body(await call());
    expect(runs[0]!.activity).toBe('stalled');
    expect(runs[0]!.idleReason).toMatch(/reclaimable/);
    expect(summary).toMatchObject({ total: 1, stalled: 1, progressing: 0 });
  });

  it('passes the { harness } / { bee } filters through to the live query', async () => {
    mockList.mockResolvedValue([] as FleetAssignmentRow[]);
    await call({ harness: 'other-harness', cup: 'su-zzz' });
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness', agent: 'su-zzz', workspaceId: 'ws-1' }),
    );
  });

  it('an idle fleet rolls up to an all-zero summary with no runs', async () => {
    mockList.mockResolvedValue([] as FleetAssignmentRow[]);
    const { ok, runs, summary } = body(await call());
    expect(ok).toBe(true);
    expect(runs).toEqual([]);
    expect(summary).toEqual({ total: 0, progressing: 0, idle: 0, stalled: 0, dead: 0 });
  });
});
