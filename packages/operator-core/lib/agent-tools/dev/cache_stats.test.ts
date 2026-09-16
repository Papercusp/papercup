/**
 * dev:cache_stats — no-http-anywhere-2026-07-28 D-074.
 *
 * Drives REAL cachedRead outcomes rather than stubbing the snapshot, so this
 * proves the counters actually reach the tool. A test that asserted only the
 * arithmetic would still pass if the tool read the wrong source — and reading
 * the wrong source is exactly the failure this tool exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachedRead,
  resetCachedReadStatsForTests,
  resetOperatorCacheForTests,
  __setCachedReadEnabledForTests,
} from '../../cache';

import tool from './cache_stats';

const ctx = { workspaceId: 'ws-cache-stats' };

function makeToolCtx(): Record<string, unknown> {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'ws-cache-stats',
    runId: 'r-cache-stats',
    role: 'operator',
  };
}

/** The tool's payload, unwrapped from the { data } envelope. */
async function read(args: { tool?: string } = {}) {
  const res = (await tool.handler(
    args as never,
    makeToolCtx() as never,
  )) as { data: Record<string, unknown> };
  return res.data;
}

describe('dev:cache_stats', () => {
  beforeEach(() => {
    resetOperatorCacheForTests();
    resetCachedReadStatsForTests();
    // cachedRead bypasses under vitest unless a cache test opts in.
    __setCachedReadEnabledForTests(true);
  });
  afterEach(() => {
    __setCachedReadEnabledForTests(false);
    resetCachedReadStatsForTests();
    resetOperatorCacheForTests();
  });

  it('reports a real miss-then-hit as 1 miss + 1 hit at 50% served', async () => {
    const factory = vi.fn(async () => [{ v: 1 }]);
    // `tags: []` throughout this file: these are TELEMETRY tests (hit/miss/stale
    // accounting), and none of them invalidates by tag — they drive the cache
    // through softTtl and fake timers instead. An empty dependency list is the
    // honest declaration for that, and it passes through to getOrSet unchanged,
    // so the runtime behaviour is identical to the pre-`tags` calls these were.
    const opts = { tool: 'plans:attention', key: { a: 1 }, tags: [], softTtlMs: 60_000 };

    await cachedRead(ctx, opts, factory); // miss  -> builds
    await cachedRead(ctx, opts, factory); // hit   -> served from L1

    const data = await read();
    const row = (data.perTool as Array<Record<string, unknown>>).find(
      (r) => r.tool === 'plans:attention',
    );

    expect(row).toBeDefined();
    expect(row).toMatchObject({ hits: 1, misses: 1, total: 2, hitRatePct: 50 });
    // The factory ran ONCE: the second call was served, not rebuilt.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('counts an SWR stale-serve as served, not as a miss', async () => {
    let now = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const factory = vi.fn(async () => [{ v: 1 }]);
      const opts = { tool: 'plans:list', key: 'k', tags: [], softTtlMs: 1_000 };

      await cachedRead(ctx, opts, factory); // miss
      now += 5_000; // past softTtl, inside hardTtl
      vi.setSystemTime(now);
      await cachedRead(ctx, opts, factory); // stale-serve (rebuilds in bg)

      const row = (
        (await read({ tool: 'plans:list' })).perTool as Array<Record<string, unknown>>
      )[0];
      expect(row).toMatchObject({ tool: 'plans:list', misses: 1, stale: 1 });
      // hitRate treats a stale-serve as served: the caller did NOT wait on a build.
      expect(row.hitRatePct).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters to one tool, and omits tools that never called cachedRead', async () => {
    const f = vi.fn(async () => [{ v: 1 }]);
    await cachedRead(ctx, { tool: 'plans:attention', key: 'a', tags: [] }, f);
    await cachedRead(ctx, { tool: 'plans:items', key: 'b', tags: [] }, f);

    const all = (await read()).perTool as Array<Record<string, unknown>>;
    expect(all.map((r) => r.tool).sort()).toEqual(['plans:attention', 'plans:items']);

    const one = (await read({ tool: 'plans:items' })).perTool as Array<Record<string, unknown>>;
    expect(one).toHaveLength(1);
    expect(one[0].tool).toBe('plans:items');

    // A tool that never called cachedRead is ABSENT, which the description
    // distinguishes from "called it and missed" — assert that, since the two
    // read identically to a caller who assumes a zero row.
    expect(all.find((r) => r.tool === 'plans:lint')).toBeUndefined();
  });

  it('sorts by traffic so the busiest consumer leads', async () => {
    const f = vi.fn(async () => [{ v: 1 }]);
    await cachedRead(ctx, { tool: 'quiet:tool', key: 'q', tags: [] }, f);
    for (let i = 0; i < 4; i++) {
      await cachedRead(ctx, { tool: 'busy:tool', key: `k${i}`, tags: [] }, f);
    }

    const rows = (await read()).perTool as Array<Record<string, unknown>>;
    expect(rows[0].tool).toBe('busy:tool');
    expect(rows[0].total).toBe(4);
  });

  it('survives an UNDEFINED args object (empty-body HTTP call / bare tools:invoke)', async () => {
    // Regression: every field on this tool is optional, so the HTTP route
    // /api/agent-tools/dev/cache_stats with an empty body hands the handler
    // `undefined` rather than `{}`. Reading `args.tool` threw
    // "Cannot read properties of undefined (reading 'tool')" against the LIVE
    // :3170 operator while all seven other tests passed — they each supplied an
    // args object, so none of them could reach this path.
    const f = vi.fn(async () => [{ v: 1 }]);
    await cachedRead(ctx, { tool: 'plans:attention', key: 'z', tags: [] }, f);

    const res = (await tool.handler(
      undefined as never,
      makeToolCtx() as never,
    )) as { data: Record<string, unknown> };

    expect(res.data.ok).toBe(true);
    expect((res.data.perTool as unknown[]).length).toBe(1);
  });

  it('always reports pid + clusterSize so per-worker counters are not read as fleet-wide', async () => {
    const data = await read();
    expect(data.pid).toBe(process.pid);
    expect(typeof data.clusterSize).toBe('number');
    expect(data.clusterSize).toBeGreaterThanOrEqual(1);
    expect(data.sampledWorkers).toBeGreaterThanOrEqual(1);
    expect(typeof data.uptimeSec).toBe('number');
  });

  it('emits the per-worker caveat only when actually clustered', async () => {
    const prev = process.env.PAPERCUSP_CLUSTER;
    const prevWorkers = process.env.PAPERCUSP_CLUSTER_WORKERS;
    try {
      // Both vars must be controlled: CLUSTER_WORKERS SHADOWS CLUSTER, so an inherited
      // one (the operator's own env sets it) would otherwise decide this assertion.
      delete process.env.PAPERCUSP_CLUSTER_WORKERS;
      process.env.PAPERCUSP_CLUSTER = '16';
      const clustered = await read();
      expect(clustered.clusterSize).toBe(16);
      expect(String(clustered.perWorkerCaveat)).toContain('16 workers');

      process.env.PAPERCUSP_CLUSTER = '1';
      expect((await read()).perWorkerCaveat).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CLUSTER;
      else process.env.PAPERCUSP_CLUSTER = prev;
      if (prevWorkers === undefined) delete process.env.PAPERCUSP_CLUSTER_WORKERS;
      else process.env.PAPERCUSP_CLUSTER_WORKERS = prevWorkers;
    }
  });

  // EI-23365791722890491 REGRESSION GUARD. This tool computed clusterSize as
  // `Number(process.env.PAPERCUSP_CLUSTER ?? 1) || 1`, which ignores the var that
  // actually wins. On the live box (CLUSTER_WORKERS=6, CLUSTER=16 — both set) it
  // therefore reported 16 workers against 6 real ones. Every assertion above still
  // passed while that was true, because none of them set both vars at once; only
  // this case distinguishes the resolver from a hand-read of the shadowed var.
  it('honours PAPERCUSP_CLUSTER_WORKERS over PAPERCUSP_CLUSTER when both are set', async () => {
    const prev = process.env.PAPERCUSP_CLUSTER;
    const prevWorkers = process.env.PAPERCUSP_CLUSTER_WORKERS;
    try {
      process.env.PAPERCUSP_CLUSTER = '16';
      process.env.PAPERCUSP_CLUSTER_WORKERS = '6';
      const data = await read();
      expect(data.clusterSize).toBe(6);
      expect(String(data.perWorkerCaveat)).toContain('6 workers');
      expect(String(data.perWorkerCaveat)).not.toContain('16 workers');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CLUSTER;
      else process.env.PAPERCUSP_CLUSTER = prev;
      if (prevWorkers === undefined) delete process.env.PAPERCUSP_CLUSTER_WORKERS;
      else process.env.PAPERCUSP_CLUSTER_WORKERS = prevWorkers;
    }
  });

  it('totals across tools and reports an empty cache without dividing by zero', async () => {
    const empty = await read();
    expect(empty.perTool).toEqual([]);
    expect(empty.totals).toMatchObject({ hits: 0, misses: 0, stale: 0, bypass: 0, deadline: 0 });
    expect(empty.killSwitchLikelyOff).toBe(false);

    const f = vi.fn(async () => [{ v: 1 }]);
    await cachedRead(ctx, { tool: 't:one', key: '1', tags: [] }, f);
    await cachedRead(ctx, { tool: 't:two', key: '2', tags: [] }, f);
    expect((await read()).totals).toMatchObject({ misses: 2 });
  });
});
