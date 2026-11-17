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
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ readyCalls: 0, failuresRemaining: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

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

const {
  getHarnessStore, closeHarnessStore, getHarnessScopedStore,
  getForeignHarnessStoreOwner, harnessStoreLockPath,
} = await import('./corestore');
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

async function opts() {
  return { workspaceRoot: await mkdtemp(join(tmpdir(), 'corestore-evict-')), harnessSlug: 'hw3' };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(open).mockImplementation(realFs.open);
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

describe('Corestore owner records are complete before publication', () => {
  it.each(['writeFile', 'sync'] as const)('keeps ownership undiscoverable until %s finishes', async (stage) => {
    const o = await opts();
    const lockPath = harnessStoreLockPath(o);
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      if (stage === 'writeFile') {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
          entered();
          await proceed;
          return write(...writeArgs);
        });
      } else {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          entered();
          await proceed;
          return sync();
        });
      }
      return handle;
    });

    const pending = getHarnessStore(o);
    try {
      await paused;
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(getForeignHarnessStoreOwner(o)).resolves.toBeNull();
      expect(h.readyCalls).toBe(0);
    } finally {
      resume();
      await pending;
      await closeHarnessStore(o);
    }
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(o.workspaceRoot, '.papercusp', o.harnessSlug))).toEqual(['hyperbee']);
  });

  it.each(['writeFile', 'sync'] as const)('cleans its candidate and retries after failed %s', async (stage) => {
    const o = await opts();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      vi.spyOn(handle, stage).mockRejectedValueOnce(new Error('injected metadata IO failure'));
      return handle;
    });
    await expect(getHarnessStore(o)).rejects.toThrow('injected metadata IO failure');
    await expect(readFile(harnessStoreLockPath(o))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(o.workspaceRoot, '.papercusp', o.harnessSlug))).toEqual(['hyperbee']);
    expect(h.readyCalls).toBe(0);

    await getHarnessStore(o);
    const record = JSON.parse(await readFile(harnessStoreLockPath(o), 'utf8'));
    expect(record).toMatchObject({ pid: process.pid, token: expect.any(String), startedAt: expect.any(String) });
    expect(record).toHaveProperty('processIdentity');
    expect(h.readyCalls).toBe(1);
    await closeHarnessStore(o);
  });

  it.each([
    { label: 'live', contents: JSON.stringify({ pid: process.pid, token: 'existing-live' }), message: 'already open' },
    { label: 'empty', contents: '', message: 'busy or corrupt' },
    { label: 'malformed', contents: '{broken', message: 'busy or corrupt' },
  ])('preserves a pre-existing $label owner record', async ({ contents, message }) => {
    const o = await opts();
    const dir = join(o.workspaceRoot, '.papercusp', o.harnessSlug);
    await mkdir(dir, { recursive: true });
    await writeFile(harnessStoreLockPath(o), contents);

    await expect(getHarnessStore(o)).rejects.toThrow(message);
    expect(await readFile(harnessStoreLockPath(o), 'utf8')).toBe(contents);
    expect((await readdir(dir)).filter((name) => name.includes('.candidate-'))).toEqual([]);
    expect(h.readyCalls).toBe(0);
  });

  it('refuses a live owner published while its candidate was being synced', async () => {
    const o = await opts();
    const contents = JSON.stringify({ pid: process.pid, token: 'concurrent-live' });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        await writeFile(harnessStoreLockPath(o), contents, { flag: 'wx' });
        await sync();
      });
      return handle;
    });
    await expect(getHarnessStore(o)).rejects.toThrow('already open');
    expect(await readFile(harnessStoreLockPath(o), 'utf8')).toBe(contents);
    expect(h.readyCalls).toBe(0);
  });

  it('keeps release fenced to the published token', async () => {
    const o = await opts();
    await getHarnessStore(o);
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
    await writeFile(harnessStoreLockPath(o), replacement);
    await closeHarnessStore(o);
    expect(await readFile(harnessStoreLockPath(o), 'utf8')).toBe(replacement);
  });
});
