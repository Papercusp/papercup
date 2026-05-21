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
import ChromeShell from '@/app/_components/ChromeShell';
import { ProgressProvider } from '@bprogress/react';
import NotFound from '../components/NotFound';
import { NavigationProgress } from '../components/NavigationProgress';
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
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      <RootSyncProvider>
        <GlobalShortcutDispatcher />
        {/* B6 — navigation progress bar. ProgressProvider renders the bar
            DOM + supplies the useProgress context (shared with RouteLink
            et al. via the @bprogress/next alias shim); NavigationProgress
            drives it from TanStack Router's status. Settings mirror the
            Next operator's RouteProgressProvider. */}
        <ProgressProvider
          height="3px"
          color="#57d7ff"
          delay={80}
          stopDelay={120}
          startPosition={0.08}
          disableSameURL
          options={{ showSpinner: false }}
        >
          <NavigationProgress />
          <Suspense fallback={null}>
            <NuqsAdapter>
              <UiPresenceProvider />
              <RouteTransitionProvider>
                <WslOnboardingGate>
                  <OperatorConversationProvider>
                    <PostHogProvider>
                      {/* Global chrome — header/navbar, left operator-chat
                          sidebar, Oracle dock. Renders before <main>,
                          mirroring the Next operator's layout.tsx.
                          (Deferred in A3 because it imports next/navigation;
                          the alias shim now resolves that.) */}
                      <ChromeShell />
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
        </ProgressProvider>
      </RootSyncProvider>
    </Tooltip.Provider>
  );
}


