/**
 * Per-harness Corestore factory.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-030.
 * v5 §7.1 — Hyperbee storage layout.
 *
 * Each harness gets its own Corestore at
 * `<workspaceRoot>/.papercusp/<harness>/hyperbee/`. Stores are
 * created lazily on first access + cached in a process-local map so
 * subsequent harness opens reuse the same store.
 *
 * Cleanup: callers explicitly close stores via `closeHarnessStore`
 * on harness-remove (rare); the process exit handler closes any
 * stale stores.
 */

import Corestore from 'corestore';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const stores = new Map<string, Promise<Corestore>>();
const storeLocks = new Map<string, HarnessStoreLock>();

interface HarnessStoreLock {
  release(): Promise<void>;
}

export interface HarnessStoreOpts {
  /** Workspace root — typically resolved from `getWorkspaceRoot()`. */
  workspaceRoot: string;
  /** Harness slug (already validated by the caller). */
  harnessSlug: string;
}

function storagePath(opts: HarnessStoreOpts): string {
  // Mirror the existing per-harness layout under .papercusp/<slug>/.
  return join(opts.workspaceRoot, '.papercusp', opts.harnessSlug, 'hyperbee');
}

/**
 * P-006 §5.1/§5.3: the SCOPED store lives in a SEPARATE Corestore at a sibling
 * path (`hyperbee-scoped/`), NOT a `.namespace()` of the main store. This is
 * load-bearing for the fail-closed serve gate: `store.replicate(socket)` serves
 * every core in ITS OWN `this.cores`/storage via the lazy `ondiscoverykey`
 * path, so a scoped core sharing the main store would be served to any peer
 * that knows its key (fail-OPEN). A distinct instance keeps scoped cores out of
 * the main store's replicate scope entirely — they are served ONLY by the
 * explicit per-core×connection attach in scope-cores.ts. This store is NEVER
 * `.replicate()`d.
 */
function scopedStoragePath(opts: HarnessStoreOpts): string {
  return join(opts.workspaceRoot, '.papercusp', opts.harnessSlug, 'hyperbee-scoped');
}

function cacheKey(opts: HarnessStoreOpts): string {
  return `${opts.workspaceRoot}::${opts.harnessSlug}`;
}

/**
 * Block cache size (in blocks) for each per-harness Corestore.
 *
 * P-005 (bg-host-freeze-eventloop-stall-2026-06-30): the DEFAULT Corestore
 * block cache is 16 384 blocks per store. With 25+ harnesses each holding
 * multiple Hypercores, the theoretical in-process RSS ceiling from block data
 * alone is tens of GB (blocks are typically 32–64 KB each). Reducing the cache
 * to 256 blocks (≈8–16 MB per store, ≈200–400 MB across 25 harnesses) bounds
 * the growth while still giving the per-harness merge loop a warm L1 for its
 * sequential append reads. Override via PAPERCUSP_CORESTORE_CACHE_BLOCKS.
 *
 * If the env-override is ≤0 or non-finite, falls back to the 256 default (no
 * footgun where CACHE=0 disables caching and hammers disk on every read).
 */
const DEFAULT_CORESTORE_CACHE_BLOCKS = 256;
// ⚠ VERIFIED INERT on the CURRENT corestore/hypercore (2026-07-01, WI-1088 hunt): this
// version's ctor consumes only `globalCache` (a Rache INSTANCE; corestore index.js:252,
// hypercore lib/core.js:48 — default null ⇒ NO block cache at all), so the `{ cache: N }`
// option below is silently ignored and the 16 384-block-default premise above is FALSE
// for this version. Kept for a future corestore that re-adds the option; do NOT count on
// it bounding anything today.
function resolveCacheBlocks(): number {
  const env = Number(process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return DEFAULT_CORESTORE_CACHE_BLOCKS;
}

/**
 * P-003 (own-log-fork-guard, WI-3535): the supported own-log-fork recovery is
 * a per-harness STORE RESET (delete this directory so Corestore lazily mints
 * a fresh keypair on next open) — exported so own-log-fork-recovery.ts (and
 * anything else that needs to name/verify the on-disk path) doesn't have to
 * re-derive the `.papercusp/<slug>/hyperbee` layout by hand.
 */
export function harnessStorePath(opts: HarnessStoreOpts): string {
  return storagePath(opts);
}

/** The advisory lock held while the writable harness Corestore is open. */
export function harnessStoreLockPath(opts: HarnessStoreOpts): string {
  return `${storagePath(opts)}.single-instance.lock`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function releaseLockFile(
  handle: FileHandle,
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    const contents = await readFile(lockPath, 'utf8');
    if (contents.includes(token)) await unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  } finally {
    await handle.close();
  }
}

async function acquireHarnessStoreLock(
  opts: HarnessStoreOpts,
): Promise<HarnessStoreLock> {
  const lockPath = harnessStoreLockPath(opts);

  // O_EXCL gives us an atomic cross-process claim without depending on a
  // platform-specific flock executable. The PID makes a lock left by a crash
  // recoverable while still refusing a live duplicate loudly.
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      let holder: { pid?: number; token?: string };
      try {
        holder = JSON.parse(await readFile(lockPath, 'utf8')) as typeof holder;
      } catch {
        throw new Error(
          `Harness Corestore lock is busy or corrupt: ${lockPath}. ` +
            'Stop the duplicate operator process and remove the lock only after verifying no owner is running.',
        );
      }

      if (!Number.isInteger(holder.pid) || processIsAlive(holder.pid!)) {
        throw new Error(
          `Harness Corestore is already open by process ${holder.pid ?? 'unknown'} ` +
            `(lock: ${lockPath}). Stop the duplicate operator/sidecar process before retrying.`,
        );
      }

      // Atomically move the stale lock out of the well-known path before
      // removing it. This prevents a concurrent opener from creating a fresh
      // lock and then having that new owner's lock unlinked by our cleanup.
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
        continue;
      }
      await unlink(stalePath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      });
      continue;
    }

    const token = randomUUID();
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await releaseLockFile(handle, lockPath, token);
      },
    };
  }
}

export async function getHarnessStore(opts: HarnessStoreOpts): Promise<Corestore> {
  const key = cacheKey(opts);
  const cached = stores.get(key);
  if (cached) return cached;

  const path = storagePath(opts);
  const pending = (async () => {
    await mkdir(path, { recursive: true });
    const lock = await acquireHarnessStoreLock(opts);
    storeLocks.set(key, lock);
    try {
      const store = new Corestore(path, { cache: resolveCacheBlocks() });
      await store.ready();
      return store;
    } catch (error) {
      storeLocks.delete(key);
      await lock.release();
      throw error;
    }
  })();
  stores.set(key, pending);
  return pending;
}

export async function closeHarnessStore(opts: HarnessStoreOpts): Promise<void> {
  const key = cacheKey(opts);
  const cached = stores.get(key);
  if (!cached) return;
  stores.delete(key);
  const store = await cached;
  try {
    await store.close();
  } finally {
    const lock = storeLocks.get(key);
    storeLocks.delete(key);
    await lock?.release();
  }
}

const scopedStores = new Map<string, Promise<Corestore>>();

/**
 * The per-harness SCOPED Corestore (P-006 §5.1) — a distinct instance from
 * {@link getHarnessStore}, lazily created + cached, NEVER `.replicate()`d. See
 * {@link scopedStoragePath} for why this must not be a namespace of the main
 * store.
 */
export async function getHarnessScopedStore(opts: HarnessStoreOpts): Promise<Corestore> {
  const key = cacheKey(opts);
  const cached = scopedStores.get(key);
  if (cached) return cached;
  const path = scopedStoragePath(opts);
  const pending = (async () => {
    await mkdir(path, { recursive: true });
    const store = new Corestore(path, { cache: resolveCacheBlocks() });
    await store.ready();
    return store;
  })();
  scopedStores.set(key, pending);
  return pending;
}

export async function closeHarnessScopedStore(opts: HarnessStoreOpts): Promise<void> {
  const key = cacheKey(opts);
  const cached = scopedStores.get(key);
  if (!cached) return;
  scopedStores.delete(key);
  const store = await cached;
  await store.close();
}

/** For tests: forget all cached stores without closing them. */
export function _resetCacheForTests(): void {
  stores.clear();
  scopedStores.clear();
}

/**
 * Test seam: read the current resolved cache-block count (respects
 * PAPERCUSP_CORESTORE_CACHE_BLOCKS). Exported only for the recurrence-guard
 * test in corestore-cache.test.ts — never call from production code.
 */
export function _resolveCorestoreCacheBlocksForTests(): number {
  return resolveCacheBlocks();
}

/** Test seam: read the default block cache constant. */
export const _DEFAULT_CORESTORE_CACHE_BLOCKS_FOR_TESTS = DEFAULT_CORESTORE_CACHE_BLOCKS;
