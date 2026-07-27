'use client';

/**
 * HarnessSyncProvider — wraps every /harness/* route with a SyncProvider.
 *
 * (Renamed from `HarnessZeroProvider` 2026-06-22: the name was a leftover from
 * the retired Rocicorp-Zero client transport — see the History note below — and
 * misleadingly implied this provider still uses Zero. It is purely SSE now.)
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
import { useEffect, type ReactNode } from 'react';
import { SyncProvider, setSyncDeltaCodec, CONNECTION_CAPPED_MAX_IN_FLIGHT } from '@papercusp/sync';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { isTauri } from '@/app/_components/SetupWizard/tauri-detect';
import { createSyncDeltaCodec } from './sync-delta-codec';

const DEFAULT_REST_ENDPOINT = '/api/zero-harness';
// SSE drift-repair tick, NOT a freshness source (EI-278). Under SSE,
// freshness comes from invalidate-driven refetches; this interval only
// repairs pushes lost to an SSE blip or a table missing its bridge entry.
// It was a shared 5_000ms pollIntervalMs — which made every subscribed
// query REST-refetch every 5s ON TOP of SSE (~3.2 fetches/s sustained on
// /adv; the dominant workload behind the 16GB webview OOM, and contrary to
// the "occasional invalidate-driven refetches" intent documented above).
// Worst-case staleness for an unbridged table is now this interval. The
// degraded POLLING fallback keeps the lib's fast pollIntervalMs default —
// there the tick IS the freshness source.
const DEFAULT_SSE_DRIFT_REPAIR_MS = 180_000;

// One QueryClient for the app lifetime. Module-scope (not useMemo) so it
// survives the provider unmount/remount that happens on some route swaps.
const queryClient = new QueryClient();

/**
 * WI-6253: the sync concurrency gate's 24-wide default is tuned for the
 * Tauri webview→sidecar IPC path, which has no real per-host connection cap.
 * A plain (non-Tauri) browser tab pointed at the dev server has NO IPC bridge
 * at all — `fetch()` always opens a real WebKitGTK/browser HTTP connection —
 * so it must use the connection-capped value instead of inheriting the
 * IPC-tuned one. (The Tauri shell's own pre-IPC-ready startup window is a
 * separate, currently-unwired case — see query-fetcher.ts's
 * `CONNECTION_CAPPED_MAX_IN_FLIGHT` doc + follow-up WI-6460.)
 *
 * Exported as a pure function (rather than inlined in the component) so this
 * decision is unit-testable without mounting React.
 */
export function resolveMaxInFlightFetches(isTauriEnv: boolean): number | undefined {
  // undefined ⇒ SyncProvider's own default (DEFAULT_MAX_IN_FLIGHT, IPC-tuned).
  return isTauriEnv ? undefined : CONNECTION_CAPPED_MAX_IN_FLIGHT;
}

// One rows-delta codec for the app lifetime (P-006). Injected into @papercusp/sync only while
// FLAGS.SYNC_RESOURCE_DELTA is ON (the effect below); OFF ⇒ no codec ⇒ full re-fetches, as today.
const syncDeltaCodec = createSyncDeltaCodec();

export function HarnessSyncProvider({
  children,
  userID = 'papercusp-anon',
  ssePollIntervalMs = DEFAULT_SSE_DRIFT_REPAIR_MS,
}: {
  children: ReactNode;
  userID?: string;
  /** SSE drift-repair tick (see DEFAULT_SSE_DRIFT_REPAIR_MS). */
  ssePollIntervalMs?: number;
}) {
  // P-006: inject the rows-delta codec while the flag is on (the owner flips it after an attended
  // desktop verify). OFF ⇒ setSyncDeltaCodec(null) ⇒ the batch fetcher serves full re-fetches.
  const deltaOn = useFlag(FLAGS.SYNC_RESOURCE_DELTA);
  useEffect(() => {
    setSyncDeltaCodec(deltaOn ? syncDeltaCodec : null);
    return () => setSyncDeltaCodec(null);
  }, [deltaOn]);

  return (
    <QueryClientProvider client={queryClient}>
      <SyncProvider
        syncType="SSE"
        userId={userID}
        restEndpoint={DEFAULT_REST_ENDPOINT}
        ssePollIntervalMs={ssePollIntervalMs}
        maxInFlightFetches={resolveMaxInFlightFetches(isTauri())}
      >
        {children}
      </SyncProvider>
    </QueryClientProvider>
  );
}
