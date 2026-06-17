/**
 * corestore-cache.test.ts — substrate-internals coverage (A5) for the
 * per-harness Corestore factory cache (corestore.ts), which had NO direct test.
 *
 * Contracts:
 *   - getHarnessStore caches by (workspaceRoot, harnessSlug): the same key returns
 *     the SAME store instance; a different key returns a DIFFERENT one.
 *   - Concurrent first-opens for one key collapse to a SINGLE store (the cache
 *     stores the in-flight Promise, so two parallel callers share one open).
 *   - closeHarnessStore evicts the cache entry: a subsequent getHarnessStore for
 *     that key opens a FRESH store (not the closed one).
 *   - closeHarnessStore on an uncached key is a no-op (no throw).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getHarnessStore,
  closeHarnessStore,
  _resetCacheForTests,
} from '../corestore';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetCacheForTests();
});

function tmpRoot(prefix = 'mb-cstore-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

describe('getHarnessStore — per-(workspaceRoot, harnessSlug) cache (A5)', () => {
  it('returns the SAME instance for the same key, a DIFFERENT instance for a different key', async () => {
    const root = tmpRoot();
    const a1 = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    const a2 = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    const b = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'B' });

    expect(a1).toBeInstanceOf(Corestore);
    expect(a2).toBe(a1); // cached
    expect(b).not.toBe(a1); // different slug → different store

    // A different workspaceRoot is also a different key.
    const root2 = tmpRoot();
    const a3 = await getHarnessStore({ workspaceRoot: root2, harnessSlug: 'A' });
    expect(a3).not.toBe(a1);

    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'B' });
    await closeHarnessStore({ workspaceRoot: root2, harnessSlug: 'A' });
  });

  it('two PARALLEL first-opens for one key collapse to a single store (one open)', async () => {
    const root = tmpRoot();
    // Fire both before awaiting either — the cache must store the in-flight
    // Promise so the second caller joins the first open rather than racing a
    // second `new Corestore` over the same path.
    const [s1, s2] = await Promise.all([
      getHarnessStore({ workspaceRoot: root, harnessSlug: 'P' }),
      getHarnessStore({ workspaceRoot: root, harnessSlug: 'P' }),
    ]);
    expect(s1).toBe(s2);
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'P' });
  });

  it('after closeHarnessStore, getHarnessStore opens a FRESH store for that key', async () => {
    const root = tmpRoot();
    const first = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });

    const second = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
    expect(second).not.toBe(first); // cache evicted → reopened fresh
    expect(second).toBeInstanceOf(Corestore);
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
  });

  it('closeHarnessStore on an uncached key is a no-op (no throw)', async () => {
    const root = tmpRoot();
    await expect(
      closeHarnessStore({ workspaceRoot: root, harnessSlug: 'never-opened' }),
    ).resolves.toBeUndefined();
  });
});
