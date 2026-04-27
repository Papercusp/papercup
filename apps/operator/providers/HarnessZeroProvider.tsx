'use client';

/**
 * HarnessZeroProvider for papercusp — connects to zero-cache-harness on :4849.
 *
 * Mirrors apps/papercup/providers/HarnessZeroProvider.tsx. Mounted at
 * `apps/papercusp/app/harness/layout.tsx` so every `/harness/*` route
 * has a single shared Zero instance. Other papercusp routes (marketplace,
 * settings, etc.) don't need Zero and are left out.
 *
 * Uses @rocicorp/zero/react directly with the @restart/zero-harness schema
 * + named-query registry. Resolves named queries through papercup's
 * /api/zero-harness-query endpoint at :3061.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Zero } from '@rocicorp/zero';
import { ZeroProvider } from '@rocicorp/zero/react';
import { schema, queries } from '@restart/zero-harness';

const DEFAULT_HARNESS_ZERO_SERVER =
  typeof window !== 'undefined'
    ? (window as unknown as { __HARNESS_ZERO_SERVER?: string }).__HARNESS_ZERO_SERVER ??
      'http://localhost:4849'
    : 'http://localhost:4849';

type CachedZero = { zero: Zero<typeof schema>; refcount: number };
const ZERO_CACHE: Map<string, CachedZero> = (() => {
  if (typeof window === 'undefined') return new Map();
  const w = window as unknown as { __HARNESS_ZERO_CACHE_PAPERCUSP__?: Map<string, CachedZero> };
  if (!w.__HARNESS_ZERO_CACHE_PAPERCUSP__) w.__HARNESS_ZERO_CACHE_PAPERCUSP__ = new Map();
  return w.__HARNESS_ZERO_CACHE_PAPERCUSP__;
})();

export function HarnessZeroProvider({
  children,
  server = DEFAULT_HARNESS_ZERO_SERVER,
  userID = 'papercusp-anon',
}: {
  children: ReactNode;
  server?: string;
  userID?: string;
}) {
  const cacheKey = `${server}::${userID}`;
  const zeroRef = useRef<Zero<typeof schema> | null>(null);

  if (!zeroRef.current) {
    const cached = ZERO_CACHE.get(cacheKey);
    if (cached) {
      cached.refcount += 1;
      zeroRef.current = cached.zero;
    } else {
      const zero = new Zero({
        server,
        userID,
        schema,
        queries,
      });
      ZERO_CACHE.set(cacheKey, { zero, refcount: 1 });
      zeroRef.current = zero;
    }
  }

  useEffect(() => {
    return () => {
      const entry = ZERO_CACHE.get(cacheKey);
      if (!entry) return;
      entry.refcount -= 1;
      if (entry.refcount <= 0) {
        try {
          entry.zero.close();
        } catch {
          /* noop */
        }
        ZERO_CACHE.delete(cacheKey);
      }
    };
  }, [cacheKey]);

  return <ZeroProvider zero={zeroRef.current!}>{children}</ZeroProvider>;
}
