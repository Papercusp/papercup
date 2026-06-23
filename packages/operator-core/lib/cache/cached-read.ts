/**
 * cachedRead — the ONE operator-side wrapper over `getOperatorCache().getOrSet`
 * (cache-expensive-tool-reads-2026-06-22 P-001 / D-003).
 *
 * Standardizes the five things every cache consumer must get right, in ONE place,
 * so each integration is ~3 lines and uniform and a future cross-cutting change
 * (a new bypass condition, richer metrics) lands here once:
 *
 *   1. workspace-scope — resolved EXACTLY as the cache-invalidation ECA bump does
 *      (`ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId()`, see
 *      `events/dispatch-reaction.ts`), so a `getOrSet` entry and the `cache.bumpTags`
 *      that must invalidate it share ONE `(workspace, tag)` generation. Throws on an
 *      empty resolve (the D-010 cross-workspace-leak guard).
 *   2. key namespacing — every key is prefixed with the tool name, so two tools can
 *      never collide on a coincidentally-equal arg key, and a key is greppable to its
 *      owning tool.
 *   3. the CACHE_LAYER kill-switch — honored by the underlying cache's `bypass` seam
 *      (getOrSet runs the factory byte-identically when off); this wrapper adds nothing
 *      that defeats it.
 *   4. per-tool telemetry — hit/miss/stale/bypass counters PER TOOL (the shared
 *      `cache.stats` can't attribute per consumer), via the cache's `onOutcome` hook.
 *   5. a deterministic args→key serializer ({@link stableKey}) — stable regardless of
 *      object key-order, so `{ a, b }` and `{ b, a }` map to the SAME cache entry.
 *
 * Reuse, NOT a new system: a thin call over the existing singleton cache + the ECA
 * invalidation already wired off the change stream.
 */

import type { CacheOutcome } from "@papercusp/cache";
import { getOperatorCache } from "./instance";
import { activeWorkspaceId } from "../workspace-registry";

/** The slice of a tool ctx cachedRead needs — workspace resolution only. */
export interface CachedReadCtx {
  workspaceId?: string | null;
  principal?: { workspaceId?: string | null } | null;
}

export interface CachedReadOptions {
  /** Tool name — the key namespace AND the telemetry bucket (e.g. 'plans:list'). */
  tool: string;
  /**
   * Everything BESIDES the workspace + tool that varies the result: the serialized
   * args + any ctx-derived dimension (e.g. the resolved harness set). A string is
   * used verbatim; anything else is run through {@link stableKey}. The caller is
   * responsible for including EVERY output-determining dimension here — a missed
   * dimension is a cross-arg leak.
   */
  key: unknown;
  /** Base-table-name data dependencies — a write to any one auto-invalidates (ECA). */
  tags: readonly string[];
  /** Serve-stale-and-revalidate after this many ms (backstop for un-triggered deps). */
  softTtlMs?: number;
  /** Force a blocking rebuild after this many ms. */
  hardTtlMs?: number;
  /** Also cache null/undefined factory results (negative caching). Default false. */
  cacheEmpty?: boolean;
}

/**
 * Resolve the cache workspace EXACTLY as the ECA bump does (events/dispatch-reaction.ts)
 * so a cached entry and the invalidation that targets it share one generation. Throws
 * if no non-empty workspace can be resolved (the D-010 cross-workspace guard).
 */
export function resolveCacheWorkspaceId(ctx: CachedReadCtx): string {
  const ws =
    ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
  if (!ws || !ws.trim()) {
    throw new Error(
      "cachedRead: no workspace to scope the cache key (workspace-scoped — D-010)",
    );
  }
  return ws;
}

/**
 * Deterministic, key-order-stable serialization of an args/key value to a string.
 * Object keys are sorted recursively, so `{ a:1, b:2 }` and `{ b:2, a:1 }` serialize
 * identically; `undefined` object fields are dropped (an absent arg == an undefined
 * arg). Arrays keep their order (the caller sorts where order is irrelevant, e.g. a
 * harness set). Primitives serialize via JSON. NOT cryptographic — a stable cache
 * discriminator only.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v);
  }
  return out;
}

// ── vitest safety gate ──────────────────────────────────────────────────────────────
// Under the vitest runner the cache-invalidation ECA (change-stream → cache.bumpTags)
// is NOT wired, so a cached tool read can't observe a same-process write — which would
// silently break the many tool-handler tests that create/mutate then re-read (e.g.
// work_items create→get→claim→get). So cachedRead BYPASSES under VITEST unless a cache
// test explicitly opts in via __setCachedReadEnabledForTests(true). This gates ONLY the
// tool-read wrapper, not getOperatorCache() itself (the cache-infra tests are untouched),
// and is inert outside vitest — a real-operator test (Playwright/LLM, VITEST unset) has
// the ECA wired, so caching stays coherent there.
let testCacheEnabled = false;

/** Test-only: enable cachedRead under the vitest runner (it bypasses by default — see above). */
export function __setCachedReadEnabledForTests(on: boolean): void {
  testCacheEnabled = on;
}

// ── per-tool telemetry (the shared cache.stats can't attribute per consumer) ────────
export interface CachedReadToolStats {
  hits: number;
  misses: number;
  stale: number;
  bypass: number;
}

const TOOL_STATS = new Map<string, CachedReadToolStats>();

function recordOutcome(tool: string, outcome: CacheOutcome): void {
  let s = TOOL_STATS.get(tool);
  if (!s) {
    s = { hits: 0, misses: 0, stale: 0, bypass: 0 };
    TOOL_STATS.set(tool, s);
  }
  if (outcome === "hit") s.hits++;
  else if (outcome === "miss") s.misses++;
  else if (outcome === "stale") s.stale++;
  else s.bypass++;
}

/** Snapshot per-tool cache telemetry (a copy — callers can't mutate the live counters). */
export function snapshotCachedReadStats(): Record<string, CachedReadToolStats> {
  const out: Record<string, CachedReadToolStats> = {};
  for (const [tool, s] of TOOL_STATS) out[tool] = { ...s };
  return out;
}

/** Test-only: clear the per-tool telemetry counters. */
export function resetCachedReadStatsForTests(): void {
  TOOL_STATS.clear();
}

/**
 * Run `factory` through the operator cache: workspace-scoped + tag-invalidated +
 * kill-switch-honoring + per-tool-metered. Returns the factory result (cached or
 * freshly built). The factory MUST be PURE / side-effect-free (D-001) — a cache hit
 * skips it entirely, and an SWR stale-serve runs it in the BACKGROUND.
 */
export async function cachedRead<V>(
  ctx: CachedReadCtx,
  opts: CachedReadOptions,
  factory: () => Promise<V> | V,
): Promise<V> {
  // Vitest safety gate: bypass the cache under test (the ECA isn't wired) unless a cache
  // test opted in. Byte-identical to no cache — just runs the factory.
  if (process.env.VITEST && !testCacheEnabled) return factory();
  const workspaceId = resolveCacheWorkspaceId(ctx);
  const keyPart = typeof opts.key === "string" ? opts.key : stableKey(opts.key);
  const fullKey = `${opts.tool}|${keyPart}`;
  return getOperatorCache().getOrSet(workspaceId, fullKey, factory, {
    tags: opts.tags,
    ...(opts.softTtlMs !== undefined ? { softTtlMs: opts.softTtlMs } : {}),
    ...(opts.hardTtlMs !== undefined ? { hardTtlMs: opts.hardTtlMs } : {}),
    ...(opts.cacheEmpty !== undefined ? { cacheEmpty: opts.cacheEmpty } : {}),
    onOutcome: (outcome) => recordOutcome(opts.tool, outcome),
  });
}
