import { beforeEach, describe, expect, it } from 'vitest';
import { createNursery } from './nursery';
import {
  computeRestartSet, createSupervisor, decideIntensity, DEFAULT_MAX_RESTARTS, type Supervisor,
} from './supervision';
import { createInMemorySpawnTreeStore } from './mem-store';
import type { LockReleaseResult, LockTarget, SpawnTreeStore } from './ports';
import type { SpawnNode } from './types';

const WS = 'default';
let store: SpawnTreeStore;
let sup: Supervisor;
let escalations: { severity: string; summary: string }[];
let lockCalls: LockTarget[][];

const spyEscalate = async (input: { severity: 'blocker'; summary: string }) => {
  escalations.push(input);
  return { msg_id: 'esc-' + escalations.length };
};
const spyReleaser = async (targets: LockTarget[]): Promise<LockReleaseResult> => {
  lockCalls.push(targets);
  return { owners: targets.map((t) => t.owner), filePathsReleased: targets.length, resourcesReleased: 0 };
};

async function spawn(spawnId: string, opts: { parent?: string | null; strategy?: SpawnNode['restartStrategy']; owner?: string } = {}) {
  await store.recordSpawn({
    spawnId, workspaceId: WS, harnessSlug: 'h', runId: 'r-' + spawnId, childRole: 'worker',
    parentSpawnId: opts.parent ?? null, sessionOwner: opts.owner ?? spawnId, restartStrategy: opts.strategy ?? 'one_for_one',
  });
}

beforeEach(() => {
  store = createInMemorySpawnTreeStore();
  const nursery = createNursery({ store, lockReleaser: spyReleaser });
  sup = createSupervisor({ store, nursery, escalate: spyEscalate });
  escalations = [];
  lockCalls = [];
});

describe('decideIntensity (pure windowing)', () => {
  it('resets a null or lapsed window to a fresh count of 1', () => {
    expect(decideIntensity({ restartCount: 9, restartWindowStart: null }, 1000, 3, 600))
      .toMatchObject({ count: 1, windowReset: true, intensityExceeded: false });
    const lapsed = new Date(1000 - 700_000);
    expect(decideIntensity({ restartCount: 9, restartWindowStart: lapsed }, 1000, 3, 600))
      .toMatchObject({ count: 1, windowReset: true });
  });
  it('increments within a live window and flags the breach above MaxR', () => {
    const winStart = new Date(1000);
    expect(decideIntensity({ restartCount: 3, restartWindowStart: winStart }, 2000, 3, 600))
      .toMatchObject({ count: 4, windowReset: false, intensityExceeded: true, windowStartMs: 1000 });
  });
});

describe('recordRestartIntensity (store-backed)', () => {
  it('counts restarts in a sliding window and trips when count exceeds MaxR', async () => {
    await spawn('w');
    const results = [];
    for (let i = 0; i < DEFAULT_MAX_RESTARTS + 1; i++) {
      results.push(await sup.recordRestartIntensity({ workspaceId: WS, spawnId: 'w' }));
    }
    expect(results.map((r) => r!.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r!.intensityExceeded)).toEqual([false, false, false, true]);
    expect(results[0]!.windowReset).toBe(true);
    expect(results[1]!.windowReset).toBe(false);
  });
  it('returns null for an unknown spawn', async () => {
    expect(await sup.recordRestartIntensity({ workspaceId: WS, spawnId: 'ghost' })).toBeNull();
  });
});

describe('computeRestartSet (pure strategy selection)', () => {
  const node = (spawnId: string, strategy: SpawnNode['restartStrategy'], status: SpawnNode['status'] = 'running', parent: string | null = 'p'): SpawnNode => ({
    spawnId, parentSpawnId: parent, workspaceId: WS, status, sessionOwner: spawnId, coordinationDomain: 'default',
    restartStrategy: strategy, restartCount: 0, restartWindowStart: null, depth: 1,
    harnessSlug: 'h', parentRole: null, childRole: 'worker', featureId: null, chunkId: null, planSlug: null, itemId: null,
  });
  it('one_for_one restarts only the crashed node', () => {
    expect(computeRestartSet(node('a', 'one_for_one'), []).toRestart).toEqual(['a']);
  });
  it('one_for_all restarts the crashed node + active siblings (terminal excluded)', () => {
    const sibs = [node('a', 'one_for_all'), node('b', 'one_for_all'), node('c', 'one_for_all', 'done')];
    expect(computeRestartSet(sibs[0], sibs).toRestart.sort()).toEqual(['a', 'b']);
  });
  it('rest_for_one restarts the crashed node + siblings started after it', () => {
    const sibs = [node('a', 'rest_for_one'), node('b', 'rest_for_one'), node('c', 'rest_for_one')];
    expect(computeRestartSet(sibs[1], sibs).toRestart).toEqual(['b', 'c']);
  });
  it('a root (no parent) behaves one_for_one regardless of declared strategy', () => {
    expect(computeRestartSet(node('r', 'one_for_all', 'running', null), []).toRestart).toEqual(['r']);
  });
});

describe('superviseCrash decision', () => {
  it('within budget → marks the restart set as restarting', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'rest_for_one' });
    await store.finishSpawn({ spawnId: 'a', workspaceId: WS, status: 'failed' });

    const res = await sup.superviseCrash({ workspaceId: WS, spawnId: 'a', reason: 'exit 1' });
    expect(res.action).toBe('restart');
    expect(res.toRestart.sort()).toEqual(['a', 'b']);
    expect((await store.getSpawn(WS, 'a'))?.status).toBe('restarting');
    expect((await store.getSpawn(WS, 'b'))?.status).toBe('restarting');
    expect(escalations).toHaveLength(0);
  });

  it('crash-loop (over budget) → tears the subtree down + escalates', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('child', { parent: 'root', owner: 'own-child' });
    // Drive to the brink: MaxR restarts already in the live window.
    for (let i = 0; i < DEFAULT_MAX_RESTARTS; i++) await sup.recordRestartIntensity({ workspaceId: WS, spawnId: 'root' });

    const res = await sup.superviseCrash({ workspaceId: WS, spawnId: 'root', reason: 'exit 1' });
    expect(res.action).toBe('escalate');
    expect(res.intensity?.intensityExceeded).toBe(true);
    expect(res.escalationId).toBe('esc-1');
    expect(escalations).toEqual([expect.objectContaining({ severity: 'blocker' })]);
    expect((await store.getSpawn(WS, 'child'))?.status).toBe('cancelled');
    expect((await store.getSpawn(WS, 'root'))?.status).toBe('failed');
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].map((t) => t.owner).sort()).toEqual(['own-child', 'own-root']);
  });

  it('returns noop for an unknown spawn', async () => {
    const res = await sup.superviseCrash({ workspaceId: WS, spawnId: 'ghost' });
    expect(res.action).toBe('noop');
  });
});
