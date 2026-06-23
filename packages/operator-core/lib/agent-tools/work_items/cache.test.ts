/**
 * work_items:list / work_items:get cache integration (cache-expensive-tool-reads-2026-06-22
 * P-005). REAL handlers + REAL operator cache; only the data layer is mocked.
 * Pins: hit-on-repeat, per-item invalidation (work_items:get tags harness_features_consolidated:<id>),
 * table-level invalidation (work_items:list), no cross-arg / cross-workspace leak, CACHE_LAYER bypass.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const M = vi.hoisted(() => ({
  listWorkItems: vi.fn(async () => [] as unknown[]),
  getWorkItem: vi.fn(async (id: string) => ({ id, kind: 'feature', title: `t-${id}`, state: 'todo' })),
  getWorkItemDetail: vi.fn(async (id: string) => ({ id, kind: 'feature', title: `t-${id}`, state: 'todo', detail: true })),
}));

vi.mock('../../work-items', async (orig) => {
  const actual = await orig<typeof import('../../work-items')>();
  return { ...actual, listWorkItems: M.listWorkItems, getWorkItem: M.getWorkItem, getWorkItemDetail: M.getWorkItemDetail };
});

import listTool from './list';
import getTool from './get';
import { getOperatorCache, resetOperatorCacheForTests, resetCachedReadStatsForTests } from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';

const CACHE_LAYER = 'papercusp-cache-layer';
const ctx = (workspaceId: string): never => ({ workspaceId, metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

const list = (args: Record<string, unknown>, ws = 'ws-wi'): Promise<unknown> => listTool.handler(args as never, ctx(ws));
const get = (args: Record<string, unknown>, ws = 'ws-wi'): Promise<unknown> => getTool.handler(args as never, ctx(ws));

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  M.listWorkItems.mockClear();
  M.getWorkItem.mockClear();
  M.getWorkItemDetail.mockClear();
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe('work_items:list — cache wiring', () => {
  it('a repeat call HITS (the read runs once)', async () => {
    await list({});
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(1);
  });

  it('a work-item write BUSTS it (tag=harness_features_consolidated)', async () => {
    await list({});
    getOperatorCache().invalidateByTags('ws-wi', ['harness_features_consolidated']);
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it('a per-row bump also busts the list (table tag is bumped alongside the row tag)', async () => {
    await list({});
    getOperatorCache().invalidateByTags('ws-wi', ['harness_features_consolidated', 'harness_features_consolidated:WI-9']);
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it('different filter args do NOT share an entry (no cross-arg leak)', async () => {
    await list({ state: 'todo' });
    await list({ state: 'done' });
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    await list({ state: 'todo' }); // cached
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it('different workspaces do NOT share an entry', async () => {
    await list({}, 'ws-A');
    await list({}, 'ws-B');
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it('CACHE_LAYER OFF ⇒ bypass', async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await list({});
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });
});

describe('work_items:get — per-item cache wiring', () => {
  it('a repeat get of the same id HITS (read runs once)', async () => {
    await get({ id: 'WI-1' });
    await get({ id: 'WI-1' });
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
  });

  it('PER-ITEM invalidation: bumping WI-1 busts WI-1 but NOT WI-2', async () => {
    await get({ id: 'WI-1' });
    await get({ id: 'WI-2' });
    expect(M.getWorkItem).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags('ws-wi', ['harness_features_consolidated:WI-1']);
    await get({ id: 'WI-1' }); // rebuilt
    await get({ id: 'WI-2' }); // still cached
    expect(M.getWorkItem).toHaveBeenCalledTimes(3);
  });

  it('a table-wide bump busts every id', async () => {
    await get({ id: 'WI-1' });
    await get({ id: 'WI-2' });
    getOperatorCache().invalidateByTags('ws-wi', ['harness_features_consolidated']);
    await get({ id: 'WI-1' });
    await get({ id: 'WI-2' });
    expect(M.getWorkItem).toHaveBeenCalledTimes(4);
  });

  it('detail vs non-detail are separate entries', async () => {
    await get({ id: 'WI-1' });
    await get({ id: 'WI-1', detail: true });
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
    expect(M.getWorkItemDetail).toHaveBeenCalledTimes(1);
  });

  it('CACHE_LAYER OFF ⇒ bypass', async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await get({ id: 'WI-1' });
    await get({ id: 'WI-1' });
    expect(M.getWorkItem).toHaveBeenCalledTimes(2);
  });
});
