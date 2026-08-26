/**
 * WI-41042 recurrence guard for the hot plan-index read-through adapter.
 *
 * Pins the contract that removed repeated listPlanIndexRows decoding from
 * system-health/Pot-survey bursts: same-key reads single-flight and hit; every
 * output dimension is isolated; and either source-table tag invalidates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const M = vi.hoisted(() => ({
  listPlanIndexRows: vi.fn(async (_opts: Record<string, unknown>) => [] as unknown[]),
  resolvePlanScope: vi.fn(async (opts: Record<string, unknown>) => ({
    workspaceId: typeof opts.workspaceId === 'string' ? opts.workspaceId : 'ws-default',
    harnessSlug: typeof opts.harnessSlug === 'string' ? opts.harnessSlug : 'papercup',
  })),
}));

vi.mock('./source', () => ({
  listPlanIndexRows: M.listPlanIndexRows,
  resolvePlanScope: M.resolvePlanScope,
}));

import { listPlanIndexRowsCached } from './index-cache';
import {
  __setCachedReadEnabledForTests,
  getOperatorCache,
  resetCachedReadStatsForTests,
  resetOperatorCacheForTests,
} from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';

const CACHE_LAYER = 'papercusp-cache-layer';
const BASE = { workspaceId: 'ws-A', harnessSlug: 'hive-A' } as const;

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.listPlanIndexRows.mockReset();
  M.listPlanIndexRows.mockResolvedValue([]);
  M.resolvePlanScope.mockClear();
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe('listPlanIndexRowsCached', () => {
  it('single-flights concurrent same-key misses and then serves a hit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows = [{ planSlug: 'one' }];
    M.listPlanIndexRows.mockImplementation(async () => {
      await gate;
      return rows;
    });

    const first = listPlanIndexRowsCached(BASE);
    const second = listPlanIndexRowsCached(BASE);
    await vi.waitFor(() => expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(rows);
    expect(b).toBe(rows);
    expect(await listPlanIndexRowsCached(BASE)).toBe(rows);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['workspaceId', { workspaceId: 'ws-B' }],
    ['harnessSlug', { harnessSlug: 'hive-B' }],
    ['includeArchived', { includeArchived: true }],
    ['status', { status: 'active' }],
    ['limit', { limit: 7 }],
    ['includeInstances', { includeInstances: true }],
    ['template', { template: 'rubric' }],
    ['templateSlug', { templateSlug: 'root-plan' }],
    ['createdSince', { createdSince: '2026-08-01T00:00:00.000Z' }],
    ['updatedSince', { updatedSince: '2026-08-02T00:00:00.000Z' }],
    ['order', { order: 'updated' as const }],
    ['includeItems', { includeItems: false }],
    ['heavyFields', { heavyFields: true }],
  ])('isolates the %s output dimension', async (_name, variant) => {
    await listPlanIndexRowsCached(BASE);
    await listPlanIndexRowsCached({ ...BASE, ...variant });
    await listPlanIndexRowsCached(BASE);
    await listPlanIndexRowsCached({ ...BASE, ...variant });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it.each(['harness_plans', 'trigger_bindings'])('%s invalidation rebuilds the entry', async (tag) => {
    await listPlanIndexRowsCached(BASE);
    await listPlanIndexRowsCached(BASE);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);

    getOperatorCache().invalidateByTags(BASE.workspaceId, [tag]);
    await listPlanIndexRowsCached(BASE);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it('passes the resolved workspace and Hive-home scope to the direct source read', async () => {
    M.resolvePlanScope.mockResolvedValueOnce({ workspaceId: 'ws-resolved', harnessSlug: 'home' });
    await listPlanIndexRowsCached({ workspaceId: 'ws-raw', harnessSlug: 'member' });
    expect(M.listPlanIndexRows).toHaveBeenCalledWith({
      workspaceId: 'ws-resolved',
      harnessSlug: 'home',
    });
  });
});
