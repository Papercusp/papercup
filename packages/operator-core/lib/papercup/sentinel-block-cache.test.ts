import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache } from '@papercusp/cache';

import { getSentinelBlockBounded } from './sentinel-block-cache';

/** A controllable build: counts calls, resolves/rejects on demand. */
function controlledBuild(block: string | null = '## Live system status') {
  let calls = 0;
  const releases: Array<{ resolve: (v: string | null) => void; reject: (e: Error) => void }> = [];
  const build = (): Promise<string | null> => {
    calls += 1;
    return new Promise<string | null>((resolve, reject) => {
      releases.push({ resolve, reject });
    });
  };
  return {
    build,
    calls: () => calls,
    resolveAll: () => {
      for (const r of releases.splice(0)) r.resolve(block);
    },
    rejectAll: (e: Error) => {
      for (const r of releases.splice(0)) r.reject(e);
    },
  };
}

describe('getSentinelBlockBounded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cold miss under the deadline returns the built block and caches it', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild('BLOCK');
    const p = getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 });
    under.resolveAll();
    await expect(p).resolves.toBe('BLOCK');
    expect(under.calls()).toBe(1);

    // Second call inside the soft TTL: served from cache, no second build.
    await expect(
      getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBe('BLOCK');
    expect(under.calls()).toBe(1);
  });

  it('cold miss past the deadline resolves null this turn, and the in-flight build serves the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild('LATE-BLOCK');
    const p = getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(2001);
    await expect(p).resolves.toBeNull();
    expect(under.calls()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded the 2000ms prompt-build deadline'));

    // The abandoned single-flight build completes and lands in cache…
    under.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    // …so the next turn gets the block without building again.
    await expect(
      getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBe('LATE-BLOCK');
    expect(under.calls()).toBe(1);
  });

  it('serves stale past the soft TTL and refreshes in the background', async () => {
    let now = 1_000_000;
    const cache = createCache({ clock: () => now });
    const under = controlledBuild('V1');
    const p1 = getSentinelBlockBounded('ws', 'hive', under.build, {
      cache,
      deadlineMs: 2000,
      softTtlMs: 45_000,
    });
    under.resolveAll();
    await expect(p1).resolves.toBe('V1');

    now += 60_000; // past soft TTL, inside hard TTL
    const under2 = controlledBuild('V2');
    // Stale serve is instant — no deadline in play.
    await expect(
      getSentinelBlockBounded('ws', 'hive', under2.build, { cache, deadlineMs: 2000, softTtlMs: 45_000 }),
    ).resolves.toBe('V1');
    expect(under2.calls()).toBe(1); // background revalidate kicked off
    under2.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      getSentinelBlockBounded('ws', 'hive', under2.build, { cache, deadlineMs: 2000, softTtlMs: 45_000 }),
    ).resolves.toBe('V2');
  });

  it('a build failure resolves null (section omitted) and never rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild();
    const p = getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 });
    under.rejectAll(new Error('digest leg down'));
    await expect(p).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('block build failed (omitting the section):'),
      'digest leg down',
    );
  });

  it('caches a null (empty-system) block so a quiet system does not re-gather every turn', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const under = controlledBuild(null);
    const p = getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 });
    under.resolveAll();
    await expect(p).resolves.toBeNull();
    await expect(
      getSentinelBlockBounded('ws', 'hive', under.build, { cache, deadlineMs: 2000 }),
    ).resolves.toBeNull();
    expect(under.calls()).toBe(1);
  });

  it('keys by scope — different scopeKeys build independently', async () => {
    const cache = createCache({ clock: () => Date.now() });
    const a = controlledBuild('A');
    const b = controlledBuild('B');
    const pa = getSentinelBlockBounded('ws', 'hive-a', a.build, { cache, deadlineMs: 2000 });
    const pb = getSentinelBlockBounded('ws', 'hive-b', b.build, { cache, deadlineMs: 2000 });
    a.resolveAll();
    b.resolveAll();
    await expect(pa).resolves.toBe('A');
    await expect(pb).resolves.toBe('B');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });
});
