'use client';

/**
 * HarnessZeroProvider — wraps every /harness/* route in the operator with
 * a polling-mode SyncProvider that resolves harness queries via the
 * REST endpoint at /api/zero-harness/rest-query.
 *
 * Polling-only on purpose: the desktop bundle has no zero-cache (pglite
 * doesn't expose logical replication, so zero-cache can't subscribe), and
 * the cloud operator deployment still works the same way — the REST
 * endpoint resolves named queries via Zero's postgres-js adapter, no
 * replica file required. Same code path on both sides.
 *
 * Uses the same @restart/sync abstraction the Restart shop's wholesale
 * page uses, so the data layer is unified across both apps.
 */
import type { ReactNode } from 'react';
import { SyncProvider } from '@restart/sync';

const DEFAULT_REST_ENDPOINT = '/api/zero-harness';
const DEFAULT_POLL_INTERVAL_MS = 3_000;

export function HarnessZeroProvider({
  children,
  userID = 'papercusp-anon',
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  children: ReactNode;
  userID?: string;
  pollIntervalMs?: number;
}) {
  return (
    <SyncProvider
      syncType="POLLING"
      userId={userID}
      restEndpoint={DEFAULT_REST_ENDPOINT}
      pollIntervalMs={pollIntervalMs}
    >
      {children}
    </SyncProvider>
  );
}
