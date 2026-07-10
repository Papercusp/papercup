import { describe, it, expect, vi } from 'vitest';
import placeBatchTool, {
  mergeBrief,
  executeBatch,
  buildPlacementWarnings,
  currentFilesFromLivePresence,
  groupPlacementsForTopicSubscribe,
  type ExecuteBatchDeps,
} from './place_batch';
import type { PlacementDecision, BatchPlacementPlan } from '../../fleet/batch-placement';
import type { PlacementTask } from '../../fleet/placement-affinity';
import type { AgentIdentity } from '../coordination/identity';

describe('buildPlacementWarnings — EI-590 silent-no-op surfacing', () => {
  it('warns when fresh spawns happen under manual wake-mode (boot-wake stages → no-op)', () => {
    const w = buildPlacementWarnings({ spawned: 3, wakeMode: 'manual' });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/manual/);
    expect(w[0]).toMatch(/3 fresh-spawned/);
    expect(w[0]).toMatch(/coord:wake-mode/);
  });

  it('is silent under auto wake-mode (the normal case)', () => {
    expect(buildPlacementWarnings({ spawned: 3, wakeMode: 'auto' })).toEqual([]);
  });

  it('is silent when nothing was fresh-spawned, even under manual (warm-inject/queue only)', () => {
    expect(buildPlacementWarnings({ spawned: 0, wakeMode: 'manual' })).toEqual([]);
  });
});

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

describe('currentFilesFromLivePresence — EI-3061 peer-lane coverage', () => {
  it('uses live peer currentFiles for touch-set exclusion and ignores stale/blank rows', () => {
    expect(
      currentFilesFromLivePresence([
        { stale: false, currentFiles: ['packages/operator-core/lib/inference-gateway/gateway.test.ts', '  '] },
        { stale: true, currentFiles: ['stale-owner.ts'] },
        { stale: false, currentFiles: ['packages/operator-core/lib/inference-gateway/gateway.test.ts', 'apps/operator/live.ts'] },
      ]),
    ).toEqual([
      'packages/operator-core/lib/inference-gateway/gateway.test.ts',
      'apps/operator/live.ts',
    ]);
  });
});

describe('groupPlacementsForTopicSubscribe — EI-1611 same-plan cohort grouping', () => {
  it('groups >=2 ACTUALLY-PLACED bees sharing a planSlug into one plan:<slug> topic', () => {
    const decisions = [
      { task: task('WI-1', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' },
      { task: task('WI-2', { planSlug: 'p-x' }), disposition: 'warm-inject', bee: 's-bee', rank: 0, reason: 'r' },
    ] as PlacementDecision[];
    const placements = [
      { task: 'WI-1', action: 'spawned', spawn_id: 's-fresh', reason: 'r' },
      { task: 'WI-2', action: 'injected', bee: 's-bee', rank: 0, reason: 'r' },
    ];
    expect(groupPlacementsForTopicSubscribe(decisions, placements)).toEqual([
      { topic: 'plan:p-x', planSlug: 'p-x', ownerIds: ['s-bee', 's-fresh'] },
    ]);
  });

  it('a lone placement on its plan is NOT a group (needs >=2 distinct bees)', () => {
    const decisions = [{ task: task('WI-1', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' }] as PlacementDecision[];
    const placements = [{ task: 'WI-1', action: 'spawned', spawn_id: 's-fresh', reason: 'r' }];
    expect(groupPlacementsForTopicSubscribe(decisions, placements)).toEqual([]);
  });

  it('tasks with no planSlug never group, even placed together', () => {
    const decisions = [
      { task: task('WI-1'), disposition: 'spawn', reason: 'r' },
      { task: task('WI-2'), disposition: 'spawn', reason: 'r' },
    ] as PlacementDecision[];
    const placements = [
      { task: 'WI-1', action: 'spawned', spawn_id: 's-a', reason: 'r' },
      { task: 'WI-2', action: 'spawned', spawn_id: 's-b', reason: 'r' },
    ];
    expect(groupPlacementsForTopicSubscribe(decisions, placements)).toEqual([]);
  });

  it('unplaced/deferred/error placements do NOT count toward a group, even sharing a plan', () => {
    const decisions = [
      { task: task('WI-1', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' },
      { task: task('WI-2', { planSlug: 'p-x' }), disposition: 'unplaced', reason: 'no headroom' },
    ] as PlacementDecision[];
    const placements = [
      { task: 'WI-1', action: 'spawned', spawn_id: 's-fresh', reason: 'r' },
      { task: 'WI-2', action: 'unplaced', reason: 'no headroom' },
    ];
    // Only ONE bee actually landed on plan p-x this batch — not a group.
    expect(groupPlacementsForTopicSubscribe(decisions, placements)).toEqual([]);
  });

  it('two DIFFERENT plans, each with 2 placed bees, produce two separate groups (sorted by planSlug)', () => {
    const decisions = [
      { task: task('WI-1', { planSlug: 'p-b' }), disposition: 'spawn', reason: 'r' },
      { task: task('WI-2', { planSlug: 'p-b' }), disposition: 'spawn', reason: 'r' },
      { task: task('WI-3', { planSlug: 'p-a' }), disposition: 'spawn', reason: 'r' },
      { task: task('WI-4', { planSlug: 'p-a' }), disposition: 'spawn', reason: 'r' },
    ] as PlacementDecision[];
    const placements = [
      { task: 'WI-1', action: 'spawned', spawn_id: 's-1', reason: 'r' },
      { task: 'WI-2', action: 'spawned', spawn_id: 's-2', reason: 'r' },
      { task: 'WI-3', action: 'spawned', spawn_id: 's-3', reason: 'r' },
      { task: 'WI-4', action: 'spawned', spawn_id: 's-4', reason: 'r' },
    ];
    expect(groupPlacementsForTopicSubscribe(decisions, placements).map((g) => g.topic)).toEqual(['plan:p-a', 'plan:p-b']);
  });
});

describe('executeBatch — EI-1611 group-topic auto-subscribe wiring', () => {
  it('ensures the plan topic + subscribes every placed bee once a >=2-bee same-plan cohort lands', async () => {
    const { fns, deps } = makeDeps();
    const r = await run(
      plan([
        { task: task('WI-1', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' },
        { task: task('WI-2', { planSlug: 'p-x' }), disposition: 'warm-inject', bee: 's-bee', rank: 0, reason: 'r' },
      ]),
      deps,
    );
    expect(fns.ensureGroupTopic).toHaveBeenCalledTimes(1);
    expect(fns.ensureGroupTopic).toHaveBeenCalledWith(actor, expect.objectContaining({ slug: 'plan:p-x' }));
    expect(fns.subscribeGroupTopic).toHaveBeenCalledTimes(2);
    expect(fns.subscribeGroupTopic).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 's-bee', source: 'fleet-spawn' }),
      'plan:p-x',
      expect.objectContaining({ mode: 'full' }),
    );
    expect(r.groups_subscribed).toBe(1);
  });

  it('a single placement (no cohort) never touches the topics deps', async () => {
    const { fns, deps } = makeDeps();
    const r = await run(plan([{ task: task('WI-1', { planSlug: 'p-solo' }), disposition: 'spawn', reason: 'r' }]), deps);
    expect(fns.ensureGroupTopic).not.toHaveBeenCalled();
    expect(fns.subscribeGroupTopic).not.toHaveBeenCalled();
    expect(r.groups_subscribed).toBeUndefined();
  });

  it('a group-topic failure is swallowed — never touches the placement result it rides on', async () => {
    const { fns, deps } = makeDeps({ ensureGroupTopic: vi.fn(async () => { throw new Error('topics down'); }) });
    const r = await run(
      plan([
        { task: task('WI-1', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' },
        { task: task('WI-2', { planSlug: 'p-x' }), disposition: 'spawn', reason: 'r' },
      ]),
      deps,
    );
    expect(r.summary.spawned).toBe(2); // the placements themselves are untouched
    expect(r.groups_subscribed).toBeUndefined();
    expect(r.group_errors?.[0]).toMatch(/plan:p-x: topics down/);
  });
});

// ── executeBatch — the gather→plan→EXECUTE path (DI seam; no fleet / PG) ──
// planBatchPlacement (the pure decision) is tested in fleet/batch-placement.test.ts;
// here we assert the EXECUTION of a plan: spawn, warm-inject, the woken:0 ladder,
// the over-ceiling await_event deferral, the inject-race, and per-placement isolation.
type AnyMock = ReturnType<typeof vi.fn>;

function makeDeps(over: Partial<Record<keyof ExecuteBatchDeps, AnyMock>> = {}) {
  const fns = {
    spawnAgentInHarness: over.spawnAgentInHarness ?? vi.fn(async (input: { spawnId?: string | null }) => ({ ok: true, spawnId: input.spawnId ?? 's-spawned', harness: 'h' })),
    claimWorkItem: over.claimWorkItem ?? vi.fn(async () => ({ ok: true })),
    releaseWorkItem: over.releaseWorkItem ?? vi.fn(async () => undefined),
    reorderWorkItem: over.reorderWorkItem ?? vi.fn(async () => undefined),
    sendMessage: over.sendMessage ?? vi.fn(async () => ({ ok: true })),
    wakeRecipients: over.wakeRecipients ?? vi.fn(async () => ({ woken: 1 })),
    ensureGroupTopic: over.ensureGroupTopic ?? vi.fn(async () => ({ topic: {}, created: true, notified: 0 })),
    subscribeGroupTopic: over.subscribeGroupTopic ?? vi.fn(async () => ({})),
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
    const reservedSpawnId = fns.spawnAgentInHarness.mock.calls[0]?.[0]?.spawnId;
    expect(fns.spawnAgentInHarness).toHaveBeenCalledTimes(1);
    expect(fns.spawnAgentInHarness).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'WI-1', itemId: 'WI-1', role: 'cup', harness: 'h', workspaceId: 'ws-1', spawnId: expect.stringMatching(/^s-/) }),
    );
    expect(fns.claimWorkItem).toHaveBeenCalledWith('WI-1', reservedSpawnId, { harness: 'h' });
    expect(r.placements[0]).toMatchObject({ task: 'WI-1', action: 'spawned', spawn_id: reservedSpawnId });
    expect(r.summary.spawned).toBe(1);
  });

  it('spawn disposition claim-race → does not spawn a stale unclaimed bee', async () => {
    const { fns, deps } = makeDeps({ claimWorkItem: vi.fn(async () => null) });
    const r = await run(plan([{ task: task('WI-1b'), disposition: 'spawn', reason: 'fresh slot' }]), deps);
    expect(fns.spawnAgentInHarness).not.toHaveBeenCalled();
    expect(fns.claimWorkItem).toHaveBeenCalledWith('WI-1b', expect.stringMatching(/^s-/), { harness: 'h' });
    expect(r.placements[0]).toMatchObject({ task: 'WI-1b', action: 'inject-raced' });
    expect(r.placements[0].reason).toMatch(/reservation lost/);
    expect(r.summary.raced).toBe(1);
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
    expect(fns.claimWorkItem).toHaveBeenCalledWith('WI-3', expect.stringMatching(/^s-/), { harness: 'h' });
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
    const claimWorkItem = vi
      .fn()
      .mockRejectedValueOnce(new Error('claim boom'))
      .mockResolvedValueOnce({ ok: true });
    const { deps } = makeDeps({
      claimWorkItem,
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

describe('fleet:place_batch args — FAIL-LOUD on unknown keys (EI-72)', () => {
  // The batch placement path fans out spawns + warm-injects with a `brief`, the
  // same hazard as cup:spawn: a field newer than a stale host's schema gets
  // silently stripped, scattering task-less placements. `.strict()` makes the
  // projection validator reject an unrecognized key with invalid_args.
  const args = (placeBatchTool as any).args;

  it('rejects an unrecognized key instead of silently stripping it', () => {
    const res = args.safeParse({ harness: 'papercup', futureField: 'x' });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error.issues)).toContain('futureField');
  });

  it('still accepts the full known key set, including brief', () => {
    const res = args.safeParse({
      tasks: ['WI-1', 'WI-2'],
      harness: 'papercup',
      max: 8,
      brief: 'situational overlay',
      tier: 'standard',
      inject_load_threshold: 3,
      min_inject_affinity: 1,
      max_inject_per_bee: 2,
      dry_run: true,
      workspace: 'ws-1',
    });
    expect(res.success).toBe(true);
  });
});
