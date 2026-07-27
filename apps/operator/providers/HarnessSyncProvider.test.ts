/**
 * resolveMaxInFlightFetches — WI-6253 recurrence guard.
 *
 * BUG: the sync concurrency gate's 24-wide default (query-fetcher.ts's
 * DEFAULT_MAX_IN_FLIGHT) was measured over the Tauri webview→sidecar IPC
 * path, which has no real per-host connection cap — but nothing in apps/
 * passed SyncProvider's `maxInFlightFetches`, so every environment (including
 * a plain non-Tauri browser tab, which has NO IPC bridge and always opens a
 * real HTTP connection subject to WebKitGTK's ~6-per-host cap) ran the
 * IPC-tuned value. This pins the actual transport-aware decision: a
 * non-Tauri environment must get the connection-capped value, never the
 * IPC-tuned default.
 */
import { describe, it, expect } from 'vitest';
import { CONNECTION_CAPPED_MAX_IN_FLIGHT } from '@papercusp/sync';
import { resolveMaxInFlightFetches } from './HarnessSyncProvider';

describe('resolveMaxInFlightFetches', () => {
  it('returns the connection-capped value for a non-Tauri (plain browser) environment', () => {
    expect(resolveMaxInFlightFetches(false)).toBe(CONNECTION_CAPPED_MAX_IN_FLIGHT);
  });

  it('defers to SyncProvider default (undefined) inside the Tauri shell', () => {
    expect(resolveMaxInFlightFetches(true)).toBeUndefined();
  });

  it('the connection-capped value is strictly below the IPC-tuned default and below the ~6-per-host browser cap', () => {
    // Sanity guard against a future edit accidentally widening the
    // connection-capped floor back up past what a real browser connection
    // pool can bear (see query-fetcher.ts's CONNECTION_CAPPED_MAX_IN_FLIGHT doc).
    expect(CONNECTION_CAPPED_MAX_IN_FLIGHT).toBeLessThan(6);
    expect(CONNECTION_CAPPED_MAX_IN_FLIGHT).toBeGreaterThan(0);
  });
});
