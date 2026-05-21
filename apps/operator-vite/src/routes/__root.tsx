import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Suspense } from 'react';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RootSyncProvider } from '@/app/_components/RootSyncProvider';
import { OperatorConversationProvider } from '@/app/_components/OperatorConversationProvider';
import { PostHogProvider } from '@/app/_components/PostHogProvider';
import WslOnboardingGate from '@/app/_components/WslOnboardingGate';
import GlobalShortcutDispatcher from '@/app/_components/GlobalShortcutDispatcher';
import RouteTransitionProvider from '@/app/_components/RouteTransitionProvider';
import { ToasterSelectionFix } from '@/app/_components/ToasterSelectionFix';
import { ToastHistoryRecorder } from '@/app/_components/ToastHistoryRecorder';
import { UiPresenceProvider } from '@/app/_components/UiPresenceProvider';
import DevReloadGate from '@/app/_components/DevReloadGate';
import PerfObserverProvider from '@/app/admin/testing/_components/PerfObserverProvider';
import RecorderHost from '@/app/admin/testing/_components/RecorderHost';
import '@/app/globals.css';

/**
 * Root route — the app shell. Translated from `apps/operator/app/layout.tsx`
 * (Phase A3 of the operator-vite migration).
 *
 * INVARIANT (host-architecture Phase 1): the IPC polyfill that installs
 * `window.EventSource = IpcEventSource` / `window.fetch = ipcFetch` runs
 * inside `RootSyncProvider` (via `installDesktopIpcPolyfills`) and must run
 * before any provider that opens a transport — that ordering is preserved
 * by keeping `RootSyncProvider` outermost of the data-layer providers.
 *
 * There is no `QueryClientProvider` — react-query is a `libs/sync` internal,
 * not an app-wide provider. Do not add one here.
 *
 * DEFERRED (need `next/navigation` → TanStack Router translation; Phase B/D):
 *   - `ChromeShell`         — header + sidebars; renders around `<Outlet/>`.
 *   - `RouteProgressProvider` — top-of-page progress bar (Phase B6, the
 *     `@bprogress/next` → `@bprogress/react` adapter).
 * Both are the only two layout-level components that import `next/*`; the
 * other 12 are translated here unchanged.
 *
 * NOT YET PORTED (Phase D/E — no SSR in a Vite SPA):
 *   - `await getAllFlags()` SSR flag resolution → `window.__PAPERCUSP_FLAGS__`.
 *     Until ported, flag-gated UI falls back to its default branch.
 *   - The `<head>` inline bootstrap scripts (visual-effects mode, op-chat
 *     width) → move to `apps/operator-vite/index.html`.
 */
export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  return (
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      <RootSyncProvider>
        <GlobalShortcutDispatcher />
        <Suspense fallback={null}>
          <NuqsAdapter>
            <UiPresenceProvider />
            <RouteTransitionProvider>
              <WslOnboardingGate>
                <OperatorConversationProvider>
                  <PostHogProvider>
                    <main data-route-transition-page="true">
                      <Outlet />
                    </main>
                  </PostHogProvider>
                </OperatorConversationProvider>
              </WslOnboardingGate>
            </RouteTransitionProvider>
            <Toaster
              theme="dark"
              position="top-right"
              richColors
              closeButton
              style={{ zIndex: 2147483646 }}
            />
            <ToasterSelectionFix />
            <ToastHistoryRecorder />
            <PerfObserverProvider />
            <RecorderHost />
            <DevReloadGate />
          </NuqsAdapter>
        </Suspense>
      </RootSyncProvider>
    </Tooltip.Provider>
  );
}

function NotFoundComponent() {
  // Phase B-1 replaces this with the translated apps/operator/app/not-found.tsx.
  return <div className="operator-vite-notfound">Page not found.</div>;
}
