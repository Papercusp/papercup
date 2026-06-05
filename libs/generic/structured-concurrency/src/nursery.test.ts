import { beforeEach, describe, expect, it } from 'vitest';
import { createNursery, type Nursery } from './nursery';
import { createInMemorySpawnTreeStore } from './mem-store';
import type { CancelNotice, LockReleaseResult, LockTarget, SpawnTreeStore } from './ports';

const WS = 'default';
let store: SpawnTreeStore;
let nursery: Nursery;
let lockCalls: LockTarget[][];
let notices: CancelNotice[];

const spyReleaser = async (targets: LockTarget[]): Promise<LockReleaseResult> => {
  lockCalls.push(targets);
  return { owners: targets.map((t) => t.owner), filePathsReleased: targets.length, resourcesReleased: 0 };
};
const spyNotifier = async (n: CancelNotice): Promise<void> => { notices.push(n); };

async function spawn(spawnId: string, opts: { parent?: string | null; owner?: string } = {}) {
  await store.recordSpawn({
    spawnId, workspaceId: WS, harnessSlug: 'h', runId: `run-${spawnId}`, childRole: 'worker',
    parentSpawnId: opts.parent ?? null, sessionOwner: opts.owner ?? null,
  });
}

beforeEach(() => {
  store = createInMemorySpawnTreeStore();
  nursery = createNursery({ store, lockReleaser: spyReleaser, notifier: spyNotifier });
  lockCalls = [];
  notices = [];
});

describe('nursery — transitive cancellation', () => {
  it('cancels the whole active subtree, leaves terminal nodes untouched', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await store.finishSpawn({ spawnId: 'C', workspaceId: WS, status: 'done' });

    const res = await nursery.cancelSubtree({ workspaceId: WS, rootSpawnId: 'root', reason: 'human abort' });
    expect(res.cancelled.map((c) => c.spawnId).sort()).toEqual(['A', 'B', 'root']);
    expect(res.alreadyTerminal).toEqual(['C']);
    expect((await store.getSpawn(WS, 'B'))?.status).toBe('cancelled');
    expect((await store.getSpawn(WS, 'C'))?.status).toBe('done');
  });

  it('releases locks for every distinct active owner (not terminal ones) and notifies them', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await store.finishSpawn({ spawnId: 'C', workspaceId: WS, status: 'failed' });

    const res = await nursery.cancelSubtree({ workspaceId: WS, rootSpawnId: 'root', reason: 'abort' });
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].map((t) => t.owner).sort()).toEqual(['own-A', 'own-B', 'own-root']); // own-C excluded
    expect(res.locks.filePathsReleased).toBe(3);
    expect(notices).toHaveLength(1);
    expect(notices[0].toOwners.sort()).toEqual(['own-A', 'own-B', 'own-root']);
    expect(res.notified.sort()).toEqual(['own-A', 'own-B', 'own-root']);
  });

  it('is idempotent — re-cancelling a terminal subtree is a no-op', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('A', { parent: 'root', owner: 'own-A' });

    await nursery.cancelSubtree({ workspaceId: WS, rootSpawnId: 'root', reason: 'first' });
    lockCalls = []; notices = [];

    const res2 = await nursery.cancelSubtree({ workspaceId: WS, rootSpawnId: 'root', reason: 'second' });
    expect(res2.cancelled).toHaveLength(0);
    expect(res2.alreadyTerminal.sort()).toEqual(['A', 'root']);
    expect(lockCalls).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('does not release locks / notify when there are no active owners', async () => {
    await spawn('solo'); // no owner
    const res = await nursery.cancelSubtree({ workspaceId: WS, rootSpawnId: 'solo', reason: 'x' });
    expect(res.cancelled.map((c) => c.spawnId)).toEqual(['solo']);
    expect(lockCalls).toHaveLength(0); // no sessionOwner → nothing to release
    expect(notices).toHaveLength(0);
  });
});

describe('nursery — completion gate', () => {
  it('refuses to complete while a child lives; allows it once the subtree is terminal', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await store.finishSpawn({ spawnId: 'C', workspaceId: WS, status: 'done' });

    expect(await nursery.openChildCount(WS, 'root')).toBe(2);
    expect(await nursery.assertCanComplete(WS, 'root')).toEqual({ canComplete: false, openChildren: 2 });

    await store.finishSpawn({ spawnId: 'B', workspaceId: WS, status: 'done' });
    await store.finishSpawn({ spawnId: 'A', workspaceId: WS, status: 'done' });
    expect(await nursery.assertCanComplete(WS, 'root')).toEqual({ canComplete: true, openChildren: 0 });
  });
});
