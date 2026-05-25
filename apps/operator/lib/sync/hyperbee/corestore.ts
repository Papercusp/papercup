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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const stores = new Map<string, Promise<Corestore>>();

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

function cacheKey(opts: HarnessStoreOpts): string {
  return `${opts.workspaceRoot}::${opts.harnessSlug}`;
}

export async function getHarnessStore(opts: HarnessStoreOpts): Promise<Corestore> {
  const key = cacheKey(opts);
  const cached = stores.get(key);
  if (cached) return cached;

  const path = storagePath(opts);
  const pending = (async () => {
    await mkdir(path, { recursive: true });
    const store = new Corestore(path);
    await store.ready();
    return store;
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
  await store.close();
}

/** For tests: forget all cached stores without closing them. */
export function _resetCacheForTests(): void {
  stores.clear();
}
