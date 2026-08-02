/**
 * memoizeDynamicImport — regression coverage for WI-6402.
 *
 * The bug: every dynamic `import()` in a bg-host per-call/per-tick hot path
 * (e.g. `loadRevoked`'s call into `../../federated-pot-scope` in boot.ts)
 * paid a SYNCHRONOUS `makeSyncRequest` round-trip to the tsx ESM loader
 * thread on EVERY invocation, not just once at boot — 11.84% of the bg-host
 * main thread in the profile that filed this bug. The fix memoises the
 * settled promise so the underlying `import()` thunk runs at most once per
 * process, while explicitly NOT caching a rejection (a transient load
 * failure must not permanently pin every later call onto a degraded path).
 */

import { describe, expect, it, vi } from 'vitest';
import { memoizeDynamicImport } from '../boot';

describe('memoizeDynamicImport (WI-6402)', () => {
  it('invokes the underlying loader at most once across many calls', async () => {
    const mod = { hello: 'world' };
    const load = vi.fn(async () => mod);
    const loadOnce = memoizeDynamicImport(load);

    const results = await Promise.all([loadOnce(), loadOnce(), loadOnce()]);
    // A later, sequential call also hits the cache, not the loader.
    const later = await loadOnce();

    expect(load).toHaveBeenCalledTimes(1);
    expect(results).toEqual([mod, mod, mod]);
    expect(later).toBe(mod);
  });

  it('does NOT cache a rejection — a transient failure is retryable, not permanent', async () => {
    let attempt = 0;
    const good = { ok: true };
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient loader-thread failure');
      return good;
    });
    const loadOnce = memoizeDynamicImport(load);

    await expect(loadOnce()).rejects.toThrow('transient loader-thread failure');
    // The failed attempt must not be cached — the next call retries the loader
    // rather than replaying (or permanently pinning callers to) the rejection.
    await expect(loadOnce()).resolves.toBe(good);
    expect(load).toHaveBeenCalledTimes(2);

    // Now that a resolution is cached, further calls hit the cache only.
    await expect(loadOnce()).resolves.toBe(good);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('is lazy — the loader thunk is not invoked until the first call', () => {
    const load = vi.fn(async () => ({}));
    memoizeDynamicImport(load);
    expect(load).not.toHaveBeenCalled();
  });

  it('concurrent in-flight callers share the SAME in-flight promise (no duplicate loader races)', async () => {
    let resolveLoad!: (v: { n: number }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ n: number }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const loadOnce = memoizeDynamicImport(load);

    const p1 = loadOnce();
    const p2 = loadOnce();
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad({ n: 1 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(r1).toEqual({ n: 1 });
  });
});
