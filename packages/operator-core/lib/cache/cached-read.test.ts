/**
 * cachedRead — the operator-side getOrSet wrapper (cache-expensive-tool-reads-2026-06-22
 * P-001). Exercised against the REAL singleton cache; only the flag backend is stubbed.
 *
 * Covers the five contracts the wrapper standardizes:
 *   - key stability (stableKey is key-order invariant; drops undefined fields)
 *   - workspace-scope (per-ctx isolation; the empty-resolve guard throws)
 *   - tag invalidation (a bumpTags on a tag busts the entry)
 *   - the CACHE_LAYER kill-switch (bypass ⇒ factory runs every call, byte-identical)
 *   - per-tool telemetry (hit/miss/stale/bypass attributed to the tool name)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

import {
  getOperatorCache,
  setOperatorCache,
  resetOperatorCacheForTests,
  _refreshCacheLayerForTests,
} from './instance';
import {
  cachedRead,
  stableKey,
  resolveCacheWorkspaceId,
  snapshotCachedReadStats,
  resetCachedReadStatsForTests,
} from './cached-read';

const CACHE_LAYER = 'papercusp-cache-layer';

const ctx = (workspaceId: string): { workspaceId: string } => ({ workspaceId });

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  vi.restoreAllMocks();
});

describe('stableKey — deterministic, key-order-stable serialization', () => {
  it('is invariant to object key order', () => {
    expect(stableKey({ a: 1, b: 2, c: 3 })).toBe(stableKey({ c: 3, b: 2, a: 1 }));
  });

  it('sorts nested object keys recursively', () => {
    expect(stableKey({ x: { p: 1, q: 2 } })).toBe(stableKey({ x: { q: 2, p: 1 } }));
  });

  it('drops undefined object fields (an absent arg == an undefined arg)', () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });

  it('preserves array order (order is significant for arrays)', () => {
    expect(stableKey([1, 2, 3])).not.toBe(stableKey([3, 2, 1]));
  });

  it('distinguishes different scalar values', () => {
    expect(stableKey({ status: 'active' })).not.toBe(stableKey({ status: 'ready' }));
  });
});

describe('cachedRead — basic caching + key stability', () => {
  it('runs the factory once and serves the cached value on repeat reads', async () => {
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(ctx('w1'), { tool: 'plans:list', key: { status: 'active' }, tags: ['harness_plans'] }, () => {
        builds++;
        return `v${builds}`;
      });
    expect(await read()).toBe('v1');
    expect(await read()).toBe('v1');
    expect(builds).toBe(1);
  });

  it('keys identically regardless of arg object key-order (same entry)', async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    await cachedRead(ctx('w1'), { tool: 't', key: { a: 1, b: 2 }, tags: [] }, factory);
    await cachedRead(ctx('w1'), { tool: 't', key: { b: 2, a: 1 }, tags: [] }, factory);
    expect(builds).toBe(1); // second call hit the same entry
  });

  it('a different arg key produces a separate entry (no cross-arg leak)', async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(ctx('w1'), { tool: 't', key: { status: 'active' }, tags: [] }, factory);
    const b = await cachedRead(ctx('w1'), { tool: 't', key: { status: 'ready' }, tags: [] }, factory);
    expect(a).toBe('v1');
    expect(b).toBe('v2');
    expect(builds).toBe(2);
  });

  it('namespaces by tool — same key under two tools never collides', async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(ctx('w1'), { tool: 'plans:list', key: 'k', tags: [] }, factory);
    const b = await cachedRead(ctx('w1'), { tool: 'plans:attention', key: 'k', tags: [] }, factory);
    expect(a).toBe('v1');
    expect(b).toBe('v2');
  });
});

describe('cachedRead — workspace scoping (D-010)', () => {
  it('keeps identical keys independent across ctx workspaces', async () => {
    let builds = 0;
    const factory = (): string => `v${++builds}`;
    const a = await cachedRead(ctx('w1'), { tool: 't', key: 'k', tags: [] }, factory);
    const b = await cachedRead(ctx('w2'), { tool: 't', key: 'k', tags: [] }, factory);
    expect(a).toBe('v1');
    expect(b).toBe('v2'); // different workspace ⇒ separate entry
    // and each is independently cached
    expect(await cachedRead(ctx('w1'), { tool: 't', key: 'k', tags: [] }, factory)).toBe('v1');
    expect(await cachedRead(ctx('w2'), { tool: 't', key: 'k', tags: [] }, factory)).toBe('v2');
  });

  it('prefers ctx.workspaceId, then principal.workspaceId, then activeWorkspaceId', () => {
    expect(resolveCacheWorkspaceId({ workspaceId: 'direct' })).toBe('direct');
    expect(resolveCacheWorkspaceId({ workspaceId: null, principal: { workspaceId: 'viaPrincipal' } })).toBe(
      'viaPrincipal',
    );
  });

  it('throws when no workspace can be resolved (the cross-workspace guard)', async () => {
    // Force activeWorkspaceId() to return empty so the guard fires.
    const reg = await import('../workspace-registry');
    vi.spyOn(reg, 'activeWorkspaceId').mockReturnValue('');
    expect(() => resolveCacheWorkspaceId({ workspaceId: null, principal: null })).toThrow(/workspace/i);
  });
});

describe('cachedRead — tag invalidation', () => {
  it('a bumpTags on a depended-on table busts the entry (rebuild on next read)', async () => {
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(ctx('w1'), { tool: 'plans:list', key: 'k', tags: ['harness_plans'] }, () => `v${++builds}`);
    expect(await read()).toBe('v1');
    expect(await read()).toBe('v1'); // cached
    getOperatorCache().invalidateByTags('w1', ['harness_plans']); // simulate an ECA bump
    expect(await read()).toBe('v2'); // rebuilt after invalidation
  });

  it("a bump in one workspace does not invalidate another's entry", async () => {
    let builds = 0;
    const read = (w: string): Promise<string> =>
      cachedRead(ctx(w), { tool: 't', key: 'k', tags: ['harness_plans'] }, () => `v${++builds}`);
    await read('w1');
    await read('w2');
    getOperatorCache().invalidateByTags('w1', ['harness_plans']);
    expect(await read('w1')).toBe('v3'); // w1 rebuilt
    expect(await read('w2')).toBe('v2'); // w2 untouched
  });
});

describe('cachedRead — stale-while-revalidate (softTtl backstop)', () => {
  it('past softTtl serves the stale value, then revalidates in the background', async () => {
    let now = 1000;
    setOperatorCache({ clock: () => now }); // singleton with an injected clock
    let builds = 0;
    const read = (): Promise<string> =>
      cachedRead(ctx('w1'), { tool: 't', key: 'k', tags: [], softTtlMs: 100 }, () => `v${++builds}`);

    expect(await read()).toBe('v1'); // miss → build
    now = 1050; // within the soft window
    expect(await read()).toBe('v1'); // fresh hit
    expect(builds).toBe(1);

    now = 1200; // past softTtl (100ms) → serve stale + background rebuild
    expect(await read()).toBe('v1'); // STALE value still served
    await new Promise((r) => setTimeout(r, 0)); // let the bg rebuild settle
    expect(builds).toBe(2); // rebuilt in the background

    expect(await read()).toBe('v2'); // now serves the revalidated value
    expect(snapshotCachedReadStats()['t']).toMatchObject({ stale: 1 });
  });
});

describe('cachedRead — CACHE_LAYER kill-switch', () => {
  it('flag OFF ⇒ bypass: the factory runs every call, byte-identical to no cache', async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    setOperatorCache(); // rebuild the singleton so it picks up the now-OFF bypass seam

    let builds = 0;
    const read = (): Promise<number> =>
      cachedRead(ctx('w1'), { tool: 't', key: 'k', tags: ['harness_plans'] }, () => ++builds);
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(await read()).toBe(3); // every call ran the factory
    // and every call was attributed as a bypass
    expect(snapshotCachedReadStats()['t']).toMatchObject({ bypass: 3, hits: 0, misses: 0 });
  });
});

describe('cachedRead — per-tool telemetry', () => {
  it('attributes hit/miss to the tool name', async () => {
    const read = (): Promise<string> =>
      cachedRead(ctx('w1'), { tool: 'plans:list', key: 'k', tags: [] }, () => 'v');
    await read(); // miss (build)
    await read(); // hit
    await read(); // hit
    expect(snapshotCachedReadStats()['plans:list']).toMatchObject({ misses: 1, hits: 2 });
  });

  it('keeps per-tool counters separate', async () => {
    await cachedRead(ctx('w1'), { tool: 'plans:list', key: 'k', tags: [] }, () => 'a');
    await cachedRead(ctx('w1'), { tool: 'plans:attention', key: 'k', tags: [] }, () => 'b');
    await cachedRead(ctx('w1'), { tool: 'plans:attention', key: 'k', tags: [] }, () => 'b');
    const stats = snapshotCachedReadStats();
    expect(stats['plans:list']).toMatchObject({ misses: 1, hits: 0 });
    expect(stats['plans:attention']).toMatchObject({ misses: 1, hits: 1 });
  });
});
