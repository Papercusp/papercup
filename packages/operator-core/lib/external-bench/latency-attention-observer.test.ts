import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache, getOrSetBounded } from '@papercusp/cache';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { cachedRead, snapshotCachedReadStats, resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests } from '../cache/cached-read';
import { installOperatorCache, resetOperatorCacheForTests, _refreshCacheLayerForTests } from '../cache/instance';
import { installL2StoreForTests, __resetL2StateForTests, _refreshL2FlagForTests } from '../cache/l2-tier';
import type { PgL2Store } from '../cache/pg-l2-store';
import { observeLatencyAttentionCache } from './latency-attention-observer';

const options = { tool: 'plans:attention', key: 'one', tags: ['coord_event_log'], softTtlMs: 20, hardTtlMs: 1000 };
beforeEach(async () => {
  resetCachedReadStatsForTests(); __setCachedReadEnabledForTests(true);
  setFlagOverridesForTest({ 'papercusp-cache-layer': true, 'papercusp-cache-l2': false });
  await _refreshCacheLayerForTests(); await _refreshL2FlagForTests();
});
afterEach(() => {
  vi.restoreAllMocks(); __setCachedReadEnabledForTests(false); resetOperatorCacheForTests();
  resetCachedReadStatsForTests(); installL2StoreForTests(null); __resetL2StateForTests(); setFlagOverridesForTest(null);
});
const deferred = () => { let resolve!: (value: string) => void;
  const promise = new Promise<string>(done => { resolve = done; }); return { promise, resolve }; };

describe('T06 host-private cache observation', () => {
  it('preserves actual single-flight, hit values, invalidation generations and original callbacks', async () => {
    const target = createCache(), observation = observeLatencyAttentionCache(target, snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    const gate = deferred(), source = vi.fn(() => gate.promise);
    const first = cachedRead({ workspaceId: 'ws' }, options, source);
    const joined = cachedRead({ workspaceId: 'ws' }, options, source);
    gate.resolve('first'); expect(await Promise.all([first, joined])).toEqual(['first', 'first']);
    expect(await cachedRead({ workspaceId: 'ws' }, options, source)).toBe('first');
    observation.cache.invalidateByTags('ws', options.tags);
    expect(await cachedRead({ workspaceId: 'ws' }, options, async () => 'second')).toBe('second');
    const callback = vi.fn();
    await observation.cache.getOrSet('ws', 'plans:attention|one', source, { onOutcome: callback });
    expect(callback).toHaveBeenCalledExactlyOnceWith('hit', 'fresh');
    const snapshot = observation.snapshot();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.factories.map(row => row.sourceBuilds)).toEqual([1, 1]);
    expect(snapshot.factories.map(row => row.generation)).toEqual([{ coord_event_log: 0 }, { coord_event_log: 1 }]);
    expect(snapshot.lookups.map(row => row.reason)).toEqual(['absent', 'absent', 'fresh', 'invalidated', 'fresh']);
    expect(target.stats.singleFlightJoins).toBe(1); expect(source).toHaveBeenCalledOnce();
  });
  it('distinguishes a real L2 hit from an aggregation build', async () => {
    setFlagOverridesForTest({ 'papercusp-cache-layer': true, 'papercusp-cache-l2': true });
    await _refreshCacheLayerForTests(); await _refreshL2FlagForTests();
    const source = vi.fn(async () => 'rebuilt');
    installL2StoreForTests({ get: async () => ({ value: 'durable-value' }) } as unknown as PgL2Store);
    const observation = observeLatencyAttentionCache(createCache(), snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    expect(await cachedRead({ workspaceId: 'ws' }, { ...options, l2: true }, source)).toBe('durable-value');
    expect(source).not.toHaveBeenCalled();
    expect(observation.snapshot()).toMatchObject({ issues: [], factories: [{ sourceBuilds: 0, after: { l2Hits: 1 } }] });
  });
  it('retains detached SWR work separately from the returned handler value', async () => {
    let now = 0; const observation = observeLatencyAttentionCache(createCache({ clock: () => now }), snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    await cachedRead({ workspaceId: 'ws' }, options, async () => 'old'); now = 21;
    const gate = deferred();
    expect(await cachedRead({ workspaceId: 'ws' }, options, () => gate.promise)).toBe('old');
    expect(observation.snapshot()).toMatchObject({ attribution: 'unavailable',
      lookups: [{}, { reason: 'soft-ttl', completedAtMs: expect.any(Number) }] });
    expect(observation.snapshot().factories[1]!.completedAtMs).toBeUndefined();
    gate.resolve('new'); await observation.drain();
    expect(observation.snapshot()).toMatchObject({ issues: [], factories: [{ sourceBuilds: 1 }, { sourceBuilds: 1 }] });
  });
  it('leaves a bounded caller free to time out while the actual factory is still running', async () => {
    const observation = observeLatencyAttentionCache(createCache(), snapshotCachedReadStats), gate = deferred();
    const result = await getOrSetBounded(observation.cache, 'ws', 'plans:attention|slow', () => gate.promise,
      { deadlineMs: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'deadline' });
    expect(observation.snapshot().issues).toContain('effective-factories-still-running');
    gate.resolve('eventually'); await observation.drain();
    expect(observation.snapshot().factories[0]!.completedAtMs).toBeTypeOf('number');
  });
  it('preserves bypass and errors without manufacturing source work', async () => {
    const observation = observeLatencyAttentionCache(createCache({ bypass: () => true }), snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    expect(await cachedRead({ workspaceId: 'ws' }, options, () => 'uncached')).toBe('uncached');
    await expect(cachedRead({ workspaceId: 'ws' }, options, () => { throw Error('source failed'); })).rejects.toThrow('source failed');
    expect(observation.snapshot()).toMatchObject({ issues: [], factories: [
      { sourceBuilds: 1 }, { sourceBuilds: 1, error: 'Error: source failed' }], finalCounters: { buildErrors: 1 } });
  });
  it('withholds per-key attribution on overlapping effective factories, preserving both results', async () => {
    const observation = observeLatencyAttentionCache(createCache(), snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    const a = deferred(), b = deferred();
    const first = cachedRead({ workspaceId: 'ws' }, options, () => a.promise);
    const other = cachedRead({ workspaceId: 'other' }, options, () => b.promise);
    a.resolve('a'); b.resolve('b'); expect(await Promise.all([first, other])).toEqual(['a', 'b']);
    expect(observation.snapshot()).toMatchObject({ attribution: 'unavailable', sourceBuildsByKeyGeneration: null });
    expect(observation.snapshot().issues).toContain('overlapping-effective-factories');
    expect(observation.snapshot().factories.every(row => row.sourceBuilds === null)).toBe(true);
  });
  it('refuses attribution with pre-existing or missing counters without changing the read', async () => {
    const stats = { ...snapshotCachedReadStats(), 'plans:attention': { builds: 1, buildsCompleted: 0,
      buildErrors: 0, l2Hits: 0, l2Misses: 0, l2Errors: 0 } };
    const observation = observeLatencyAttentionCache(createCache(), () => stats as unknown as ReturnType<typeof snapshotCachedReadStats>);
    expect(await observation.cache.getOrSet('ws', 'plans:attention|one', () => 'value')).toBe('value');
    expect(observation.snapshot().issues).toContain('source-build-predates-observer');
    const missing = observeLatencyAttentionCache(createCache(), () => { throw Error('unavailable'); });
    expect(await missing.cache.getOrSet('ws', 'plans:attention|one', () => 'value')).toBe('value');
    expect(missing.snapshot().issues).toContain('source-counters-unavailable');
  });
  it('keeps other cache consumers and all methods on the original receiver', async () => {
    const target = createCache(), observation = observeLatencyAttentionCache(target, snapshotCachedReadStats);
    expect(await observation.cache.getOrSet('ws', 'plans:list|one', () => 'plain')).toBe('plain');
    expect(observation.snapshot().lookups).toEqual([]);
    expect(observation.cache.stats).toBe(target.stats);
    observation.cache.invalidateByTag('ws', 'plans');
    expect(target.generationSnapshot('ws', ['plans'])).toEqual({ plans: 1 });
  });
  it('detects completed source work that bypassed the facade between observed windows', async () => {
    const target = createCache(), observation = observeLatencyAttentionCache(target, snapshotCachedReadStats);
    installOperatorCache(observation.cache);
    await cachedRead({ workspaceId: 'ws' }, options, async () => 'observed');
    installOperatorCache(target);
    await cachedRead({ workspaceId: 'ws' }, { ...options, key: 'unobserved' }, async () => 'outside');
    installOperatorCache(observation.cache);
    expect(observation.snapshot()).toMatchObject({ attribution: 'unavailable', sourceBuildsByKeyGeneration: null });
    expect(observation.snapshot().issues).toContain('source-counter-census-mismatch');
  });
});
