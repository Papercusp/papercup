/**
 * The L2 read-through/write-through seam (no-http-anywhere-2026-07-28 P-007 / D-082).
 *
 * WHAT PROBLEM THIS SOLVES. D-078 measured the plans.* hydration cost and found the
 * cache was never broken — it hit 87.5% on a single-process control. The cost is that
 * :3070 runs a 16-worker reuseport cluster and the cache is L1-only, so each worker
 * pays its OWN cold build and one worker's work cannot serve the other fifteen. The
 * observable symptom is user-facing: 60 sequential requests showed 10.0s deadline hits
 * across requests 1-30 and none across 31-60 — i.e. the app is slowest immediately
 * after every deploy/restart, when all 16 workers are cold at once.
 *
 * WHY IT LIVES HERE AND NOT IN THE LIB. `instance.ts` records that L2 was left unwired
 * because the generic `Cache` has "no value-tier read-through/write-through seam ... it
 * needs a `getOrSet` value-tier port on the lib, OR AN OPERATOR-SIDE WRAPPER". The
 * second option needs no lib change and already exists: `cachedRead` is that wrapper
 * and is the single chokepoint every cached operator read passes through. So this file
 * wraps the FACTORY rather than modifying `@papercusp/cache` — which keeps the
 * borrowable lib domain-free (generic-first) and leaves single-flight, the generation
 * snapshot and the `getOrSetBounded` deadline completely untouched.
 *
 * WHY WRAPPING THE FACTORY IS CORRECT AND NOT A HACK. `Cache.getOrSet` runs the
 * caller's factory on EXACTLY an L1 miss or a dead entry (and in the background on an
 * SWR stale-serve). That is precisely the set of moments L2 should be consulted, so
 * the wrap gives real read-through: an L1 hit never touches Postgres at all, and the
 * value L2 returns is written into this worker's L1 by the lib's own `build()`.
 *
 * ── THE ONE SUBTLE DECISION: L2 ENTRIES EXPIRE AT THE **SOFT** TTL ────────────────
 * A naive wrap silently breaks SWR. When an L1 entry passes its soft TTL the lib
 * serves it stale and revalidates in the BACKGROUND — that revalidate calls the
 * factory, which would read L2, find the same old value, and return it. The entry
 * would then never actually refresh until its hard TTL or a tag-bust, defeating the
 * soft TTL entirely. The soft TTL is the documented backstop for UN-TAGGED
 * dependencies (plans:attention folds ~10 sources, several deliberately un-tagged), so
 * losing it would mean a new escalation or message never surfacing for up to 10min.
 *
 * The fix is to bound an L2 row's life by the SOFT ttl (`softTtlMs ?? hardTtlMs`), not
 * the hard one. `PgL2Store.get` already treats an expired row as a miss, so this needs
 * no schema change and no read-side clock comparison. The invariant it buys:
 *
 *     L2 serves a value ONLY while that value would ALSO have been FRESH in L1.
 *
 * So L2 can never make anything staler than L1 alone would have served — it is
 * strictly a cold-start sharer, which is exactly the measured problem. Past the soft
 * TTL every worker rebuilds exactly as it does today. This deliberately preserves
 * invalidation semantics rather than changing them (D-082's stop-and-record rule).
 *
 * TAG INVALIDATION is deletion, not a read-side generation check: `cache.bumpTags`
 * also calls `invalidateL2ByTags`, which DELETEs matching rows. Because a busted row
 * is gone, the read path stays a single SELECT with no generation comparison.
 *
 * OPT-IN PER CALL SITE (`l2: true` on cachedRead). Values cross a jsonb round-trip, so
 * a `Date`/`Map`/`Set` in a cached value would come back reshaped. Every value that
 * opts in must be plain JSON. Scoping to the call sites D-078 actually measured keeps
 * this correct by construction instead of by audit, and the global flag can still kill
 * the whole tier at once.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { pinModuleState } from '@papercusp/module-singleton';
import { systemDistinctId } from '../flag-distinct-id';
import { cacheLayerEnabled } from './instance';
import { PgL2Store } from './pg-l2-store';

/** What an L2 consultation did — reported to cachedRead for per-tool telemetry. */
export type L2Outcome = 'hit' | 'miss' | 'error' | 'off';

/*
 * Realm-pinned like `instance.ts`'s cache state, and for the same reason: a split
 * module would otherwise wire a second `onFlagChange` subscription and keep its own
 * copy of the sync-cached kill-switch (EI-19479108855357092).
 */
const __state = pinModuleState<{
  store: PgL2Store | null;
  l2On: boolean;
  flagWiringInit: boolean;
}>('@papercusp/operator-core.cacheL2Tier', () => ({
  store: null,
  l2On: false,
  flagWiringInit: false,
}));

/**
 * Fail SAFE — but note the safe direction here is the OPPOSITE of CACHE_LAYER's.
 * CACHE_LAYER defaults ON on a read error because losing the cache is a performance
 * cliff; L2 defaults OFF because a flag hiccup must not silently start serving values
 * from a durable cross-process store. Degrading to L1-only is always correct.
 */
async function refreshL2Flag(): Promise<void> {
  try {
    __state.l2On = await getFlag(FLAGS.CACHE_L2, systemDistinctId());
  } catch {
    __state.l2On = false;
  }
}

function ensureFlagWiring(): void {
  if (__state.flagWiringInit) return;
  __state.flagWiringInit = true;
  void refreshL2Flag();
  onFlagChange((key) => {
    if (key === null || key === FLAGS.CACHE_L2) void refreshL2Flag();
  });
}

/**
 * Whether the durable L2 tier is live. SUBORDINATE to CACHE_LAYER on purpose: that
 * kill-switch means "no cache", not "no L1", so it must take L2 down with it —
 * otherwise pulling the panic switch would leave a durable tier still serving.
 */
export function l2TierEnabled(): boolean {
  ensureFlagWiring();
  return __state.l2On && cacheLayerEnabled();
}

/** The process-wide L2 store (stateless — it opens the shared org pool per call). */
export function getL2Store(): PgL2Store {
  if (!__state.store) __state.store = new PgL2Store();
  return __state.store;
}

/** Test seam: install a specific store (or clear it, so the next get rebuilds). */
export function installL2StoreForTests(store: PgL2Store | null): void {
  __state.store = store;
}

/** Test seam: force the sync-cached flag, bypassing the async read. */
export function setL2EnabledForTests(on: boolean): void {
  __state.flagWiringInit = true;
  __state.l2On = on;
}

/**
 * Test-only: re-read CACHE_L2 synchronously-awaitably, mirroring
 * `_refreshCacheLayerForTests`. Preferred over {@link setL2EnabledForTests} in a test
 * that wants the REAL flag path exercised (the lazy `void` read may not have settled).
 */
export async function _refreshL2FlagForTests(): Promise<void> {
  __state.flagWiringInit = true;
  await refreshL2Flag();
}

export interface L2WrapOptions {
  /** Data dependencies — a `cache.bumpTags` on any of these DELETEs the row. */
  tags: readonly string[];
  /** The caller's soft TTL; bounds the L2 row's life (see the header). */
  softTtlMs?: number;
  /** Fallback bound when the caller set no soft TTL. */
  hardTtlMs?: number;
  /** Reports what the L2 consultation did, for per-tool telemetry. */
  onL2Outcome?: (outcome: L2Outcome) => void;
}

/**
 * Wrap `factory` with L2 read-through + write-through.
 *
 * Returns the factory UNCHANGED when the tier is off, so a disabled L2 is
 * byte-identical to the L1-only behaviour that shipped before — no wrapper frame, no
 * PG dependency acquired, nothing to reason about.
 *
 * NEVER THROWS ON L2's BEHALF: any store error degrades to running the real factory.
 * A cache tier that can fail a user's read is worse than no cache tier.
 */
/**
 * How long an L2 row may live: the SOFT ttl, falling back to the hard one only when
 * no soft ttl was set. Extracted and exported so the invariant it encodes is directly
 * testable against a deliberately-wrong control — the property "prefers soft over
 * hard" is invisible to a test that only checks the happy path, because BOTH orderings
 * return a number and both look right.
 *
 * Returns `undefined` when there is no usable bound, which callers must treat as
 * "do not use L2" rather than "cache forever".
 */
export function l2RowTtlMs(opts: { softTtlMs?: number; hardTtlMs?: number }): number | undefined {
  const ttlMs = opts.softTtlMs ?? opts.hardTtlMs;
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return ttlMs;
}

export function withL2<V>(
  workspaceId: string,
  fullKey: string,
  factory: () => Promise<V> | V,
  opts: L2WrapOptions,
): () => Promise<V> | V {
  if (!l2TierEnabled()) return factory;

  // The soft TTL bounds the row (see the header). No usable bound ⇒ no L2: an
  // unbounded durable row could outlive every reader's notion of freshness.
  const ttlMs = l2RowTtlMs(opts);
  if (ttlMs === undefined) return factory;

  return async (): Promise<V> => {
    const store = getL2Store();
    try {
      const hit = await store.get<V>(workspaceId, fullKey);
      if (hit) {
        opts.onL2Outcome?.('hit');
        return hit.value;
      }
      opts.onL2Outcome?.('miss');
    } catch {
      // Read failure ⇒ fall through and build. Never surface a cache-tier error.
      opts.onL2Outcome?.('error');
    }

    const value = await factory();

    // Write-through is FIRE-AND-FORGET: the caller is already waiting on a cold
    // build, and making them also wait on a PG write would add latency to the exact
    // path this tier exists to speed up. A lost write just means the next worker
    // rebuilds — the status quo.
    if (value !== undefined && value !== null) {
      void store
        .set(workspaceId, fullKey, value, { tags: opts.tags, hardTtlMs: ttlMs })
        .catch(() => undefined);
    }
    return value;
  };
}

/**
 * Delete every L2 row carrying any of `tags`. Called from the `cache.bumpTags`
 * built-in action so an invalidation reaches the durable tier, not just the
 * in-process generation counters.
 *
 * Fire-and-forget + never throws: `bumpTags` is a reaction on the change stream and
 * must not fail because the durable tier hiccuped. A missed delete is bounded by the
 * row's soft-TTL expiry, so the failure mode is "stale for up to one soft TTL", never
 * "stale forever".
 */
export function invalidateL2ByTags(workspaceId: string, tags: readonly string[]): void {
  if (!l2TierEnabled() || tags.length === 0) return;
  void getL2Store()
    .invalidateByTags(workspaceId, tags)
    .catch(() => undefined);
}
