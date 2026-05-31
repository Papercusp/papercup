'use client';

/**
 * HarnessZeroProvider — connects papercup to the harness Zero.
 *
 * Server URL resolution (in order):
 *   1. window.__HARNESS_ZERO_SERVER  (server-rendered injection from layout.tsx,
 *      driven by the HARNESS_ZERO_SERVER container env)
 *   2. process.env.NEXT_PUBLIC_HARNESS_ZERO_SERVER  (build-time inline)
 *   3. http://localhost:4849  (dev fallback)
 *
 * SSR: @rocicorp's ZeroProvider only constructs Zero in useEffect (client-only)
 * and returns null while undefined. We accept that — children that consume
 * Zero render only after hydration. Routes that need static SSR for a shell
 * should render outside this provider; routes that use useZero/useQuery
 * render inside and wait for client mount.
 */
import { type ReactNode } from 'react';
import { ZeroProvider } from '@rocicorp/zero/react';
import { schema, queries } from '@papercusp/zero-harness';

const ENV_HARNESS_ZERO_SERVER =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_HARNESS_ZERO_SERVER) || '';

function resolveServer(): string {
  const fallback = ENV_HARNESS_ZERO_SERVER || 'http://localhost:4849';
  if (typeof window !== 'undefined') {
    return (window as any).__HARNESS_ZERO_SERVER ?? fallback;
  }
  return fallback;
}

export function HarnessZeroProvider({
  children,
  userId,
  server,
}: {
  children: ReactNode;
  userId?: string;
  server?: string;
}) {
  return (
    <ZeroProvider
      userID={userId ?? 'harness-public'}
      server={server ?? resolveServer()}
      schema={schema}
      queries={queries as any}
    >
      {children}
    </ZeroProvider>
  );
}
