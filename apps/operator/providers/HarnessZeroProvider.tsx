'use client';

/**
 * HarnessZeroProvider — wraps every /harness/* route with a SyncProvider.
 *
 * Transport selection by deployment context (2026-05-07):
 *
 *   - **Desktop (Tauri shell)** → SSE primary. PG LISTEN/NOTIFY →
 *     /api/zero-harness/sse pushes invalidate/update events. No
 *     zero-cache process needed; the operator sidecar serves SSE itself.
 *
 *   - **Browser (web deploy)** → Zero WS primary. /api/runtime-config
 *     returns the live `zeroServer` URL (production zero-cache or dev),
 *     SyncProvider's WS adapter mounts against it. SSE acts as a
 *     fallback if WS fails.
 *
 * Detection: `window.__TAURI_INTERNALS__` is present iff we're in the
 * Tauri webview. Anywhere else (including dev browser at :3070) is the
 * browser path.
 *
 * Both paths share `useSyncQuery({queryName, args})` for consumers — the
 * only thing that varies is which transport adapter mounts.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SyncProvider } from '@restart/sync';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { schema as harnessSchema } from '@restart/zero-harness/schema';
import { queries as harnessQueries } from '@restart/zero-harness/queries';

const DEFAULT_REST_ENDPOINT = '/api/zero-harness';
const DEFAULT_POLL_INTERVAL_MS = 5_000;

interface RuntimeConfig {
  zeroServer: string | null;
}

type RuntimeKind = 'tauri' | 'browser' | 'unknown';

function detectRuntimeFromWindow(): RuntimeKind {
  if (typeof window === 'undefined') return 'unknown';
  // Override for development / verdict-based smoke tests:
  //   localStorage.harnessSyncTransport = 'SSE' | 'WEBSOCKETS'
  try {
    const override = window.localStorage.getItem('harnessSyncTransport');
    if (override === 'SSE') return 'tauri';
    if (override === 'WEBSOCKETS') return 'browser';
  } catch { /* sandbox may block localStorage */ }
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return 'tauri';
  }
  return 'unknown';
}

export function HarnessZeroProvider({
  children,
  userID = 'papercusp-anon',
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  children: ReactNode;
  userID?: string;
  pollIntervalMs?: number;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);

  // Initial guess from window globals + localStorage override. May be
  // 'unknown' when window-side signals are unclear (e.g. some SSR
  // hydration paths); resolved by the server fingerprint below.
  const [runtime, setRuntime] = useState<RuntimeKind>(detectRuntimeFromWindow);
  const [zeroServer, setZeroServer] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let aborted = false;

    // Belt-and-suspenders: confirm the runtime via `/api/desktop/version`,
    // which returns `isDesktop: true` iff the server-side env has
    // PAPERCUSP_DESKTOP=1 (set by the Tauri sidecar). This catches the
    // case where window.__TAURI_INTERNALS__ isn't yet attached at the
    // time of our first detection and survives navigation/reload (whereas
    // localStorage doesn't persist across origins).
    fetch('/api/desktop/version')
      .then((r) => r.ok ? r.json() : null)
      .then((info: { isDesktop?: boolean } | null) => {
        if (aborted) return;
        if (info?.isDesktop) setRuntime('tauri');
      })
      .catch(() => { /* server fingerprint unavailable; use window-side guess */ });

    return () => { aborted = true; };
  }, []);

  useEffect(() => {
    if (runtime === 'tauri') {
      setResolved(true); // SSE doesn't need a zeroServer
      return;
    }
    let aborted = false;
    fetch('/api/runtime-config')
      .then((r) => r.ok ? r.json() : { zeroServer: null })
      .then((cfg: RuntimeConfig) => {
        if (aborted) return;
        setZeroServer(cfg.zeroServer);
        setResolved(true);
      })
      .catch(() => {
        if (aborted) return;
        setResolved(true); // POLLING fallback
      });
    return () => { aborted = true; };
  }, [runtime]);

  let inner: ReactNode;
  if (runtime === 'tauri') {
    inner = (
      <SyncProvider
        syncType="SSE"
        userId={userID}
        restEndpoint={DEFAULT_REST_ENDPOINT}
        pollIntervalMs={pollIntervalMs}
      >
        {children}
      </SyncProvider>
    );
  } else if (resolved && zeroServer) {
    inner = (
      <SyncProvider
        syncType="WEBSOCKETS"
        userId={userID}
        server={zeroServer}
        schema={harnessSchema}
        queries={harnessQueries}
        restEndpoint={DEFAULT_REST_ENDPOINT}
        pollIntervalMs={pollIntervalMs}
      >
        {children}
      </SyncProvider>
    );
  } else {
    // Browser path while runtime-config resolves, OR no zero-cache running.
    // POLLING is the safety net.
    inner = (
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

  return (
    <QueryClientProvider client={queryClient}>
      {inner}
    </QueryClientProvider>
  );
}
