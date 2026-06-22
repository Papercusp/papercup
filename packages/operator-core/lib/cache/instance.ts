/**
 * The operator's singleton `Cache` instance (caching-layer-tag-eca-2026-06-22 P-004).
 *
 * `@papercusp/cache` is a pure, dependency-free library; the *one* process-wide
 * instance the operator reads/writes through lives HERE so it can be injected at
 * the call sites (cache consumers) and at the event-reaction `cache.bumpTags`
 * action that invalidates it off the change stream.
 *
 * Anchored on `globalThis` (the same pattern as the reaction registry in
 * `../events/registry.ts`): every importer — the tsx runtime AND a vitest module
 * graph — shares ONE instance, so a `getOrSet` write and a `bumpTags`
 * invalidation that arrive through different modules hit the same L1 + the same
 * per-(workspace,tag) generation counters. (The lib intentionally does NOT anchor
 * a singleton — process-wide sharing is this host's concern.)
 *
 * L2 (the durable `PgL2Store` in `./pg-l2-store`) is built and tested (P-003) but
 * NOT yet wired here: the generic `Cache` exposes a `generationStore` seam (the
 * tag-invalidation bus) but no value-tier read-through/write-through seam, so
 * wiring L2 around `getOrSet` is a focused follow-up (it needs a `getOrSet`
 * value-tier port on the lib, or an operator-side wrapper). For now the instance
 * is L1-only: correct in-process, warm-until-restart. See the follow note in the
 * P-004 completion report.
 */

import { createCache, type Cache, type CacheConfig } from '@papercusp/cache';
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { systemDistinctId } from '../flag-distinct-id';

const GLOBAL_KEY = '__papercuspOperatorCache__';

/**
 * L1 bound (P-018 operational hardening). The lib default is 10_000; the operator
 * sets an explicit, higher cap appropriate to its working set so the entry count is
 * a conscious decision (and so the LRU is the memory backstop, not OOM). Each entry
 * is a small `CacheEntry` (a value ref + a few tags + two timestamps), so 50k caps
 * the cache at low-tens-of-MB even with chunky values.
 */
const MAX_L1_ENTRIES = 50_000;

// ── CACHE_LAYER kill-switch (P-018) ────────────────────────────────────────────
// The cache READ path (getOrSet) is synchronous-fast and can't await a flag, so the
// CACHE_LAYER flag is held in a SYNC-cached boolean refreshed on first use + every
// flag change (the CACHE_TAG_ECA / WORKITEM_CLAIM_LEASE precedent). DEFAULT ON. We
// fail SAFE: any read error (flag store hiccup) leaves the cache ENABLED — a
// transient flag-read failure must not silently disable the cache. The `bypass` seam
// inverts it: bypass === !enabled.
//
// The flag wiring is initialized LAZILY (on the first getOperatorCache / refresh),
// NOT at module load: this module is in the import closure of `sync-sse.ts` (the
// P-017 cold-bust wiring), and a module-load `onFlagChange(...)` would force EVERY
// sync-sse importer's module graph to evaluate `@papercusp/flags/server` — breaking
// the many unit tests that mock that module with only `getFlag`. Lazy init means
// only code that actually USES the cache touches the flag subscription.
let cacheLayerOn = true;
let flagWiringInit = false;

async function refreshCacheLayer(): Promise<void> {
  try {
    cacheLayerOn = await getFlag(FLAGS.CACHE_LAYER, systemDistinctId());
  } catch {
    cacheLayerOn = true; // fail-safe ⇒ cache stays on (default behavior)
  }
}

/** Idempotently install the flag subscription + prime the sync-cached value. */
function ensureFlagWiring(): void {
  if (flagWiringInit) return;
  flagWiringInit = true;
  void refreshCacheLayer();
  onFlagChange((key) => {
    if (key === null || key === FLAGS.CACHE_LAYER) void refreshCacheLayer();
  });
}

/** Whether the operator L1 cache layer is live (SYNC-cached CACHE_LAYER flag). */
export function cacheLayerEnabled(): boolean {
  return cacheLayerOn;
}

/** Test-only: re-read CACHE_LAYER synchronously-awaitably (the lazy `void` read may not have settled). */
export async function _refreshCacheLayerForTests(): Promise<void> {
  await refreshCacheLayer();
}

/** The default operator-cache config: an explicit L1 bound + the kill-switch bypass seam. */
function operatorCacheConfig(extra: CacheConfig = {}): CacheConfig {
  return { maxL1Entries: MAX_L1_ENTRIES, bypass: () => !cacheLayerOn, ...extra };
}

/**
 * The one process-wide operator `Cache`. Lazily constructed on first use and
 * anchored on `globalThis` so every module (and a vitest graph) shares it.
 */
export function getOperatorCache(): Cache {
  ensureFlagWiring();
  const g = globalThis as Record<string, unknown>;
  let c = g[GLOBAL_KEY] as Cache | undefined;
  if (!c) {
    c = createCache(operatorCacheConfig());
    g[GLOBAL_KEY] = c;
  }
  return c;
}

/**
 * Test seam: replace the process-wide instance (e.g. with an injected clock /
 * generation store) and return it. Call `setOperatorCache()` with no args, or
 * `resetOperatorCacheForTests()`, to drop the override so the next
 * `getOperatorCache()` rebuilds a fresh default.
 */
export function setOperatorCache(config: CacheConfig = {}): Cache {
  ensureFlagWiring();
  // Layer the caller's config OVER the operator defaults (bound + kill-switch
  // bypass), so an override still honors the CACHE_LAYER kill-switch unless the
  // test deliberately passes its own `bypass`.
  const c = createCache(operatorCacheConfig(config));
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = c;
  return c;
}

/** Test seam: install a specific Cache instance as the process-wide singleton. */
export function installOperatorCache(cache: Cache): Cache {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = cache;
  return cache;
}

/** Test-only: drop the singleton so the next `getOperatorCache()` rebuilds it. */
export function resetOperatorCacheForTests(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
