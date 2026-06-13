import { describe, it, expect, vi } from 'vitest';
import { mergeBrief, executeBatch, type ExecuteBatchDeps } from './place_batch';
import type { PlacementDecision, BatchPlacementPlan } from '../../fleet/batch-placement';
import type { PlacementTask } from '../../fleet/placement-affinity';
import type { AgentIdentity } from '../coordination/identity';

describe('mergeBrief — per-lane brief + Queen overlay (queen-wave-dispatch P-031)', () => {
  it('combines the lane brief and the batch overlay, lane first', () => {
    expect(mergeBrief('lane context', 'queen overlay')).toBe('lane context\n\nqueen overlay');
  });

  it('returns whichever single brief is present', () => {
    expect(mergeBrief('lane only', null)).toBe('lane only');
    expect(mergeBrief(null, 'overlay only')).toBe('overlay only');
    expect(mergeBrief('lane only', undefined)).toBe('lane only');
    expect(mergeBrief(undefined, 'overlay only')).toBe('overlay only');
  });

  it('treats whitespace-only as absent and returns null when neither is real', () => {
    expect(mergeBrief('   ', '')).toBeNull();
    expect(mergeBrief(null, undefined)).toBeNull();
    expect(mergeBrief('  ', 'real')).toBe('real');
  });
});

// ── executeBatch — the gather→plan→EXECUTE path (DI seam; no fleet / PG) ──
// planBatchPlacement (the pure decision) is tested in fleet/batch-placement.test.ts;
// here we assert the EXECUTION of a plan: spawn, warm-inject, the woken:0 ladder,
// the over-ceiling await_event deferral, the inject-race, and per-placement isolation.
type AnyMock = ReturnType<typeof vi.fn>;

function makeDeps(over: Partial<Record<keyof ExecuteBatchDeps, AnyMock>> = {}) {
  const fns = {
    spawnAgentInHarness: over.spawnAgentInHarness ?? vi.fn(async () => ({ ok: true, spawnId: 's-spawned', harness: 'h' })),
    claimWorkItem: over.claimWorkItem ?? vi.fn(async () => ({ ok: true })),
    releaseWorkItem: over.releaseWorkItem ?? vi.fn(async () => undefined),
    reorderWorkItem: over.reorderWorkItem ?? vi.fn(async () => undefined),
    sendMessage: over.sendMessage ?? vi.fn(async () => ({ ok: true })),
    wakeRecipients: over.wakeRecipients ?? vi.fn(async () => ({ woken: 1 })),
  };
  return { fns, deps: fns as unknown as ExecuteBatchDeps };
}

const task = (id: string, over: Partial<PlacementTask> = {}): PlacementTask => ({
  id,
  harness: 'h',
  title: `Task ${id}`,
  ...over,
});

const plan = (decisions: PlacementDecision[]): BatchPlacementPlan => ({
  decisions,
  spawnCount: decisions.filter((d) => d.disposition === 'spawn').length,
  injectCount: decisions.filter((d) => d.disposition === 'warm-inject').length,
  unplacedCount: decisions.filter((d) => d.disposition === 'unplaced').length,
  projectedLoad: {},
  remainingHeadroom: 0,
});

const actor = { ownerId: 's-queen' } as unknown as AgentIdentity;
const run = (p: BatchPlacementPlan, deps: ExecuteBatchDeps, headroom = 2) =>
  executeBatch({ plan: p, headroom, brief: null, tier: null, actor, role: 'operator', workspaceId: 'ws-1', deps });

describe('executeBatch — placement execution', () => {
  it('spawn disposition → fresh spawn, reported as spawned', async () => {
    const { fns, deps } = makeDeps();
    const r = await run(plan([{ task: task('WI-1'), disposition: 'spawn', reason: 'fresh slot' }]), deps);
    expect(fns.spawnAgentInHarness).toHaveBeenCalledTimes(1);
    expect(fns.spawnAgentInHarness).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'WI-1', role: 'bee', harness: 'h', workspaceId: 'ws-1' }),
    );
    expect(r.placements[0]).toMatchObject({ task: 'WI-1', action: 'spawned', spawn_id: 's-spawned' });
    expect(r.summary.spawned).toBe(1);
  });

  it('warm-inject delivered (woken≥1) → claim + reorder + waking send, reported as injected', async () => {
    const { fns, deps } = makeDeps();
    const r = await run(
      plan([{ task: task('WI-2'), disposition: 'warm-inject', bee: 's-bee', rank: 0, reason: 'high affinity' }]),
      deps,
    );
    expect(fns.claimWorkItem).toHaveBeenCalledWith('WI-2', 's-bee', { harness: 'h' });
    expect(fns.reorderWorkItem).toHaveBeenCalled();
    const [, sentMsg] = fns.sendMessage.mock.calls[0] as [unknown, { to: string[]; extra?: { wake?: boolean } }];
    expect(sentMsg.to).toEqual(['s-bee']);
    expect(sentMsg.extra).toMatchObject({ wake: true });
    expect(fns.wakeRecipients).toHaveBeenCalledWith(
      ['s-bee'],
      expect.objectContaining({ source: 's-queen', workspaceId: 'ws-1' }),
    );
    expect(r.placements[0]).toMatchObject({ task: 'WI-2', action: 'injected', bee: 's-bee', rank: 0 });
    expect(r.summary.injected).toBe(1);
    expect(fns.spawnAgentInHarness).not.toHaveBeenCalled();
  });

  it('woken:0 ladder → releases the item and climbs to a fresh spawn when headroom remains', async () => {
    const { fns, deps } = makeDeps({ wakeRecipients: vi.fn(async () => ({ woken: 0 })) });
    // one warm-inject, spawnCount 0 → extraSpawnBudget = headroom(2) − 0 = 2
    const r = await run(
      plan([{ task: task('WI-3'), disposition: 'warm-inject', bee: 's-asleep', rank: 0, reason: 'affinity' }]),
      deps,
      2,
    );
    expect(fns.releaseWorkItem).toHaveBeenCalledWith('WI-3', { harness: 'h' });
    expect(fns.spawnAgentInHarness).toHaveBeenCalledTimes(1); // climbed the ladder
    expect(r.placements[0]).toMatchObject({ task: 'WI-3', action: 'spawned', climbed_from: 's-asleep' });
    expect(r.placements[0].reason).toMatch(/woken:0/);
    expect(r.summary.spawned).toBe(1);
  });

  it('woken:0 ladder → releases to the frontier as unplaced when no spawn headroom', async () => {
    const { fns, deps } = makeDeps({ wakeRecipients: vi.fn(async () => ({ woken: 0 })) });
    // headroom 0 → extraSpawnBudget 0 → cannot climb
    const r = await run(
      plan([{ task: task('WI-4'), disposition: 'warm-inject', bee: 's-asleep', rank: 0, reason: 'affinity' }]),
      deps,
      0,
    );
    expect(fns.releaseWorkItem).toHaveBeenCalledWith('WI-4', { harness: 'h' });
    expect(fns.spawnAgentInHarness).not.toHaveBeenCalled();
    expect(r.placements[0]).toMatchObject({ task: 'WI-4', action: 'unplaced', bee: 's-asleep' });
    expect(r.placements[0].reason).toMatch(/no spawn headroom/);
  });

  it('inject-race: the item is claimed by another agent first → inject-raced, no send', async () => {
    const { fns, deps } = makeDeps({ claimWorkItem: vi.fn(async () => null) });
    const r = await run(
      plan([{ task: task('WI-5'), disposition: 'warm-inject', bee: 's-bee', rank: 0, reason: 'affinity' }]),
      deps,
    );
    expect(fns.claimWorkItem).toHaveBeenCalled();
    expect(fns.reorderWorkItem).not.toHaveBeenCalled();
    expect(fns.sendMessage).not.toHaveBeenCalled();
    expect(r.placements[0]).toMatchObject({ task: 'WI-5', action: 'inject-raced', bee: 's-bee' });
    expect(r.summary.raced).toBe(1);
  });

  it('over the fleet ceiling → defers with await_event and defers the rest without re-spawning', async () => {
    const spawnFn = vi.fn(async () => ({ ok: false, awaitEvent: 'fleet:slot-freed', error: 'over ceiling' }));
    const { deps } = makeDeps({ spawnAgentInHarness: spawnFn });
    const r = await run(
      plan([
        { task: task('WI-6a'), disposition: 'spawn', reason: 'slot' },
        { task: task('WI-6b'), disposition: 'spawn', reason: 'slot' },
      ]),
      deps,
      2,
    );
    expect(spawnFn).toHaveBeenCalledTimes(1); // 2nd is deferred without another spawn attempt
    expect(r.placements[0]).toMatchObject({ task: 'WI-6a', action: 'deferred', await_event: 'fleet:slot-freed' });
    expect(r.placements[1]).toMatchObject({ task: 'WI-6b', action: 'deferred' });
    expect(r.await_event).toBe('fleet:slot-freed');
    expect(r.next).toMatch(/events:await/);
    expect(r.summary.deferred).toBe(2);
  });

  it('per-placement isolation: one placement throwing does not abort the batch', async () => {
    const { deps } = makeDeps({
      claimWorkItem: vi.fn(async () => {
        throw new Error('claim boom');
      }),
    });
    const r = await run(
      plan([
        { task: task('WI-7a'), disposition: 'warm-inject', bee: 's-bee', rank: 0, reason: 'affinity' },
        { task: task('WI-7b'), disposition: 'spawn', reason: 'slot' },
      ]),
      deps,
      2,
    );
    expect(r.placements[0]).toMatchObject({ task: 'WI-7a', action: 'error' });
    expect(r.placements[1]).toMatchObject({ task: 'WI-7b', action: 'spawned' });
    expect(r.summary.failed).toBe(1);
  });

  it('unplaced disposition is passed through untouched (no effects fire)', async () => {
    const { fns, deps } = makeDeps();
    const r = await run(plan([{ task: task('WI-8'), disposition: 'unplaced', reason: 'batch cap reached' }]), deps);
    expect(r.placements[0]).toMatchObject({ task: 'WI-8', action: 'unplaced', reason: 'batch cap reached' });
    expect(fns.spawnAgentInHarness).not.toHaveBeenCalled();
    expect(fns.claimWorkItem).not.toHaveBeenCalled();
    expect(r.summary.unplaced).toBe(1);
  });
});
