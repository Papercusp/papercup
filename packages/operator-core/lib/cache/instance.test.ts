/**
 * Operator cache singleton — P-017 (cold-bust on listener reconnect) + P-018
 * (kill-switch + L1 bound).
 *
 * Two contracts, both exercised against the REAL `@papercusp/cache` and the REAL
 * `createPgListenSource` adapter — only the flag backend (no PostHog) and the PG
 * connection (a fake postgres-js client) are stubbed:
 *
 *   1. P-017 — a (re)connect on the LISTEN source fires the operator's `onListen`,
 *      which clears the singleton's L1 (so NOTIFYs missed during a dropped
 *      connection can't leave stale entries). We wire `createPgListenSource` with
 *      the SAME `onListen: () => getOperatorCache().clearL1()` callback sync-sse.ts
 *      uses, drive a reconnect, and assert a warm entry rebuilds.
 *
 *   2. P-018 — CACHE_LAYER OFF makes the singleton bypass: getOrSet always runs the
 *      factory (no L1). ON ⇒ it caches. The bound (maxL1Entries) is set explicitly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { createPgListenSource, type PgSqlLike } from '@papercusp/sync/server/pg';

import {
  getOperatorCache,
  setOperatorCache,
  resetOperatorCacheForTests,
  cacheLayerEnabled,
  _refreshCacheLayerForTests,
} from './instance';

const CACHE_LAYER = 'papercusp-cache-layer';

/** Fake postgres-js client that lets a test re-fire `onlisten` (reconnect). */
function makeFakeSql(): { sql: PgSqlLike; reconnect: () => void } {
  let onListen: (() => void) | undefined;
  const sql = {
    listen(_ch: string, _notify: (p: string) => void, listen?: () => void) {
      onListen = listen;
      listen?.(); // initial connect
      return Promise.resolve(undefined);
    },
    async end() {},
  } as unknown as PgSqlLike;
  return { sql, reconnect: () => onListen?.() };
}

beforeEach(async () => {
  resetOperatorCacheForTests();
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
});

describe('P-017 — cold-bust on listener (re)connect', () => {
  it('a reconnect on the wired LISTEN source clears the singleton L1 (entry rebuilds)', async () => {
    const cache = getOperatorCache();
    let builds = 0;
    const factory = (): string => `v${++builds}`;

    // Warm an entry.
    expect(await cache.getOrSet('w1', 'k', factory)).toBe('v1');
    expect(await cache.getOrSet('w1', 'k', factory)).toBe('v1'); // cached hit
    expect(builds).toBe(1);

    // Wire the LISTEN source EXACTLY as sync-sse.ts does: onListen → clearL1.
    const fake = makeFakeSql();
    const src = createPgListenSource({
      open: () => fake.sql,
      channel: 'sync_invalidate',
      onListen: () => getOperatorCache().clearL1(),
    });
    await src.start(() => {});
    // The initial connect already cold-busts; the warm entry is gone.
    expect(await cache.getOrSet('w1', 'k', factory)).toBe('v2');
    expect(builds).toBe(2);

    // Re-warm, then simulate a dropped connection + reconnect → another cold-bust.
    expect(await cache.getOrSet('w1', 'k', factory)).toBe('v2'); // cached
    expect(builds).toBe(2);
    fake.reconnect();
    expect(await cache.getOrSet('w1', 'k', factory)).toBe('v3'); // rebuilt after reconnect
    expect(builds).toBe(3);
  });
});

describe('P-018 — CACHE_LAYER kill-switch', () => {
  it('flag ON (default) ⇒ the singleton caches; cacheLayerEnabled() is true', async () => {
    expect(cacheLayerEnabled()).toBe(true);
    const cache = getOperatorCache();
    let builds = 0;
    const f = (): string => `v${++builds}`;
    expect(await cache.getOrSet('w1', 'k', f)).toBe('v1');
    expect(await cache.getOrSet('w1', 'k', f)).toBe('v1');
    expect(builds).toBe(1); // cached
  });

  it('flag OFF ⇒ the singleton bypasses: getOrSet always runs the factory', async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    expect(cacheLayerEnabled()).toBe(false);

    // setOperatorCache layers the operator defaults (incl. the bypass seam) so the
    // freshly-built singleton honors the now-OFF flag too.
    const cache = setOperatorCache();
    let builds = 0;
    const f = (): string => `v${builds++}`;
    await cache.getOrSet('w1', 'k', f);
    await cache.getOrSet('w1', 'k', f);
    await cache.getOrSet('w1', 'k', f);
    expect(builds).toBe(3); // every call ran the factory — no caching while bypassed
  });

  it('flipping the flag OFF→ON re-enables caching on the same singleton (sync-cached refresh)', async () => {
    const cache = getOperatorCache(); // built while ON
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();

    let builds = 0;
    const f = (): string => `v${builds++}`;
    await cache.getOrSet('w1', 'k', f);
    await cache.getOrSet('w1', 'k', f);
    expect(builds).toBe(2); // bypassed

    setFlagOverridesForTest({ [CACHE_LAYER]: true });
    await _refreshCacheLayerForTests();
    await cache.getOrSet('w1', 'k', f); // builds once, then caches
    await cache.getOrSet('w1', 'k', f);
    expect(builds).toBe(3);
  });
});
