import { createRootRoute, Outlet } from '@tanstack/react-router';

/**
 * Root route — the app shell.
 *
 * INVARIANT (host-architecture Phase 1): the IPC polyfill that installs
 * `window.EventSource = IpcEventSource` / `window.fetch = ipcFetch` must run
 * BEFORE `RootSyncProvider` mounts — i.e. before the provider tree below.
 * When the provider stack is wired (Phase A3), keep the polyfill first.
 *
 * Verified provider stack to translate from `apps/operator/app/layout.tsx`
 * (in nesting order):
 *   Tooltip.Provider > RootSyncProvider > RouteProgressProvider > NuqsAdapter
 *   > UiPresenceProvider > RouteTransitionProvider > OperatorConversationProvider
 *   > PostHogProvider   (+ PerfObserverProvider as a sibling)
 *
 * There is no QueryClientProvider — react-query is a `libs/sync` internal,
 * not an app-wide provider. Do not add one here.
 *
 * Scaffold state (Phase A): bare `<Outlet/>`. Provider wiring is A3.
 */
export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  return <Outlet />;
}

function NotFoundComponent() {
  // Phase B-1 replaces this with the translated apps/operator/app/not-found.tsx.
  return <div className="operator-vite-notfound">Page not found.</div>;
}
