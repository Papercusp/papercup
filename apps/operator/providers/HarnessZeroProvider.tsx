'use client';

/**
 * HarnessZeroProvider — wraps every /harness/* route with a SyncProvider.
 *
 * Transport: **SSE for every runtime** (desktop Tauri shell *and* plain
 * browser). The operator sidecar serves `/api/zero-harness/sse` itself —
 * PG LISTEN/NOTIFY → invalidate/update events — so SSE works identically
 * whether the page is loaded inside the Tauri webview or a normal browser
 * tab pointed at the dev server.
 *
 * History: the browser path used to mount a Zero WebSocket adapter against
 * a separate `zero-cache` process, configured via `/api/runtime-config`'s
 * `zeroServer` field. zero-cache was retired in the Level 1 + Phase 1 SSE
 * cutover (2026-05-07), leaving that WebSocket branch unreachable (the
 * browser silently fell through to `syncType="POLLING"`). The dead
 * `/api/runtime-config` endpoint and the `zeroServer` plumbing were removed
 * 2026-06-03. (The reusable WebSocket transport itself still lives in
 * `@papercusp/sync` for other apps — Papercusp simply no longer selects it.)
 *
 * POLLING is catastrophic here: the dashboard registers ~40 distinct Zero
 * queries, and the polling adapter re-fetches *every one of them* via
 * `/api/zero-harness/rest-query` on each interval. ~40 concurrent requests
 * against a browser's 6-connection-per-host HTTP/1.1 cap permanently
 * saturates the pool — every other request on the page (the live-thinking
 * popover's EventSource, on-demand fetches, …) is starved and hangs in
 * `CONNECTING` forever. SSE uses a *single* long-lived connection plus
 * occasional invalidate-driven refetches, so the pool stays healthy.
 *
 * POLLING still exists as the genuine last-resort fallback — `SyncProvider`'s
 * internal `useTransportFallback` drops SSE → POLLING after sustained SSE
 * failure. That is the degraded mode, not the default.
 */
import { type ReactNode } from 'react';
import { SyncProvider } from '@papercusp/sync';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const DEFAULT_REST_ENDPOINT = '/api/zero-harness';
// Drift-repair tick, NOT a freshness source (EI-278). Under SSE, freshness
// comes from invalidate-driven refetches; this interval only repairs pushes
// lost to an SSE blip or a table missing its bridge entry. It was 5_000 —
// which made every subscribed query REST-refetch every 5s on top of SSE
// (~3.2 fetches/s sustained on /adv; the dominant workload behind the
// 16GB webview OOM). Worst-case staleness for an unbridged table is now
// this interval. The POLLING transport (degraded mode) keeps its own fast
// cadence — there polling IS the freshness source.
const DEFAULT_POLL_INTERVAL_MS = 180_000;

// One QueryClient for the app lifetime. Module-scope (not useMemo) so it
// survives the provider unmount/remount that happens on some route swaps.
const queryClient = new QueryClient();

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
    <QueryClientProvider client={queryClient}>
      <SyncProvider
        syncType="SSE"
        userId={userID}
        restEndpoint={DEFAULT_REST_ENDPOINT}
        pollIntervalMs={pollIntervalMs}
      >
        {children}
      </SyncProvider>
    </QueryClientProvider>
  );
}
