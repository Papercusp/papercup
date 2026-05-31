'use client';
import type { ReactNode } from 'react';
import { HarnessZeroProvider } from '../../providers/HarnessZeroProvider';
import { installDesktopIpcPolyfills } from '../../lib/transport-adapters/desktop-bootstrap';
import { installWorkspaceHeaderFetch } from '../../lib/transport-adapters/workspace-header-fetch';

/**
 * Root sync provider. Wraps the app in `HarnessZeroProvider` and, on
 * Tauri, installs the desktop IPC polyfills so same-origin /api/*
 * `fetch` and every `EventSource` ride the IPC bridge instead of the
 * webview's HTTP connection pool.
 *
 * The install fires at *module-evaluation time*, not in `useEffect`:
 * React effects run in child-first commit order, so a `useEffect` here
 * would land *after* child components' effects had already opened their
 * SSE streams against the native `EventSource`. Module-eval runs once
 * per bundle load, well before any component's runtime
 * `new EventSource(...)` call. See
 * `lib/transport-adapters/desktop-bootstrap.ts` for the install rules.
 *
 * `installWorkspaceHeaderFetch` runs immediately after, so it wraps whatever
 * `window.fetch` now is — `ipcFetch` on desktop, native fetch in the dev
 * browser — stamping `x-papercusp-workspace` on operator API calls so the
 * backend resolves per-window, not against the global `reg.current`
 * (per-window-workspace-context-2026-05-31, P-013).
 */
if (typeof window !== 'undefined') {
  installDesktopIpcPolyfills();
  installWorkspaceHeaderFetch();
}

export function RootSyncProvider({ children }: { children: ReactNode }) {
  return <HarnessZeroProvider>{children}</HarnessZeroProvider>;
}
