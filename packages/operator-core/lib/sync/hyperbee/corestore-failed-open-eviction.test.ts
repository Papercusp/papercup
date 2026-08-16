/**
 * EI-20584279536840151 — a FAILED store open must not poison the cache.
 *
 * `getHarnessStore` caches the in-flight promise so concurrent callers share one
 * open. The original code only ever `set` that promise, never removed it, so a
 * REJECTED open stayed cached and every later call re-returned the same
 * rejection. On the macOS rig this turned a one-line on-disk fault into a
 * permanent one: the substrate logged a byte-identical
 * `boot_fail … Invalid device file, was modified` every ~10 minutes for hours,
 * and kept logging it AFTER the on-disk cause had been repaired, because no
 * retry ever reached the disk again. Only a process restart cleared it.
 *
 * `poisonedCache` below is the original idiom, kept permanently as a control so
 * these tests demonstrate they can actually tell a retrying cache from a stuck
 * one — a test that only asserts "the second call succeeds" passes just as
 * happily against an implementation that never cached anything at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ readyCalls: 0, failuresRemaining: 0 }));

vi.mock('corestore', () => ({
  default: class FakeCorestore {
    constructor(readonly path: string) {}
    async ready(): Promise<void> {
      h.readyCalls++;
      if (h.failuresRemaining > 0) {
        h.failuresRemaining--;
        throw new Error('Invalid device file, was modified');
      }
    }
    async close(): Promise<void> {}
  },
}));

vi.mock('./remote-core-host', () => ({
  registerStoreMachine: vi.fn(),
  forgetStore: vi.fn(),
}));

const { getHarnessStore, closeHarnessStore, getHarnessScopedStore } = await import('./corestore');

async function opts() {
  return { workspaceRoot: await mkdtemp(join(tmpdir(), 'corestore-evict-')), harnessSlug: 'hw3' };
}

afterEach(() => {
  h.readyCalls = 0;
  h.failuresRemaining = 0;
});

/**
 * CONTROL — the original caching idiom, which never evicts a rejection. Shown
 * here to fail the very property the tests below assert of the real module.
 */
function poisonedCache() {
  const cache = new Map<string, Promise<string>>();
  return (key: string, attempt: () => Promise<string>) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = attempt();
    cache.set(key, pending);
    return pending;
  };
}

describe('failed corestore opens are evicted from the cache', () => {
  it('CONTROL: the original idiom replays the rejection and never retries', async () => {
    let attempts = 0;
    const get = poisonedCache();
    const attempt = async () => {
      attempts++;
      if (attempts === 1) throw new Error('Invalid device file, was modified');
      return 'store';
    };

    await expect(get('k', attempt)).rejects.toThrow('Invalid device file');
    // The disk has been "repaired" — but the cache answers from memory.
    await expect(get('k', attempt)).rejects.toThrow('Invalid device file');
    expect(attempts).toBe(1); // it never looked again
  });

  it('getHarnessStore retries a previously failed open', async () => {
    const o = await opts();
    h.failuresRemaining = 1;

    await expect(getHarnessStore(o)).rejects.toThrow('Invalid device file');
    expect(h.readyCalls).toBe(1);

    // The on-disk cause is now gone; the next caller must actually re-open.
    const store = await getHarnessStore(o);
    expect(store).toBeDefined();
    expect(h.readyCalls).toBe(2);

    await closeHarnessStore(o);
  });

  it('getHarnessStore still caches a SUCCESSFUL open (eviction targets failures only)', async () => {
    const o = await opts();

    const a = await getHarnessStore(o);
    const b = await getHarnessStore(o);

    expect(a).toBe(b);
    expect(h.readyCalls).toBe(1); // second call served from cache, not re-opened

    await closeHarnessStore(o);
  });

  it('repeated failures keep retrying rather than latching', async () => {
    const o = await opts();
    h.failuresRemaining = 3;

    for (let i = 0; i < 3; i++) {
      await expect(getHarnessStore(o)).rejects.toThrow('Invalid device file');
    }
    expect(h.readyCalls).toBe(3); // each attempt reached the store, not the cache

    await expect(getHarnessStore(o)).resolves.toBeDefined();
    await closeHarnessStore(o);
  });

  it('getHarnessScopedStore retries a previously failed open', async () => {
    const o = await opts();
    h.failuresRemaining = 1;

    await expect(getHarnessScopedStore(o)).rejects.toThrow('Invalid device file');
    await expect(getHarnessScopedStore(o)).resolves.toBeDefined();
    expect(h.readyCalls).toBe(2);
  });

  it('concurrent callers still share ONE in-flight open', async () => {
    const o = await opts();

    const [a, b] = await Promise.all([getHarnessStore(o), getHarnessStore(o)]);

    expect(a).toBe(b);
    expect(h.readyCalls).toBe(1);

    await closeHarnessStore(o);
  });
});
