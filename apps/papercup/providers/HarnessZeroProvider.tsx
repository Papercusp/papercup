'use client';

/**
 * HarnessZeroProvider — connects papercup to the harness Zero (zero-cache-harness on :4849).
 *
 * Distinct from apps/web's AppZeroProvider, which:
 *   - points at zero-cache on :4848 (the `restart` shop DB)
 *   - uses the @restart/sync wrapper with named-query registry
 *
 * The harness Zero uses the @rocicorp/zero/react client directly because:
 *   - libs/sync's resolveQuery.ts hardcodes `import { queries } from '@restart/zero'`
 *     and isn't yet pluggable for a second schema
 *   - direct ZeroProvider gives us `useQuery(zql.<table>...)` with the harness
 *     schema, which is sufficient for the first wave of harness panel conversions
 *
 * If we later need named queries, useSyncVirtualizer, or transport-fallback
 * polling for the harness, libs/sync needs a small refactor to take the
 * registry/schema as props rather than hardcoding @restart/zero.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Zero } from '@rocicorp/zero';
import { ZeroProvider } from '@rocicorp/zero/react';
import { schema, queries } from '@restart/zero-harness';

const DEFAULT_HARNESS_ZERO_SERVER =
  typeof window !== 'undefined'
    ? (window as any).__HARNESS_ZERO_SERVER ?? 'http://localhost:4849'
    : 'http://localhost:4849';

type CachedZero = { zero: Zero<typeof schema>; refcount: number };
const ZERO_CACHE: Map<string, CachedZero> = (() => {
  if (typeof window === 'undefined') return new Map();
  const w = window as unknown as { __HARNESS_ZERO_CACHE__?: Map<string, CachedZero> };
  if (!w.__HARNESS_ZERO_CACHE__) w.__HARNESS_ZERO_CACHE__ = new Map();
  return w.__HARNESS_ZERO_CACHE__;
})();

export function HarnessZeroProvider({
  children,
  // Force a fresh userID per session for now to bypass any stale CVR state
  // from prior debug iterations. Replace with a stable per-user ID later.
  userId = `harness-${Date.now()}`,
  server,
}: {
  children: ReactNode;
  userId?: string;
  server?: string;
}) {
  const zeroServer = server ?? DEFAULT_HARNESS_ZERO_SERVER;
  const cacheKey = `${userId}|${zeroServer}`;
  const zeroRef = useRef<Zero<typeof schema> | null>(null);

  let cached = ZERO_CACHE.get(cacheKey);
  if (!cached) {
    const zero = new Zero({
      userID: userId,
      server: zeroServer,
      schema,
      queries,
    } as any);
    cached = { zero, refcount: 0 };
    ZERO_CACHE.set(cacheKey, cached);
  }
  zeroRef.current = cached.zero;

  useEffect(() => {
    const entry = ZERO_CACHE.get(cacheKey);
    if (!entry) return;
    entry.refcount += 1;
    return () => {
      entry.refcount -= 1;
      if (entry.refcount <= 0) {
        try { entry.zero.close?.(); } catch { /* ignore */ }
        ZERO_CACHE.delete(cacheKey);
      }
    };
  }, [cacheKey]);

  return <ZeroProvider zero={zeroRef.current}>{children}</ZeroProvider>;
}
