// First imports, before any route module or dependency evaluates: install the
// Node globals that Vite (unlike Next's webpack) does not provide — `process`
// (operator code reads `process.env.*` at module-eval; see process-polyfill.ts)
// and `Buffer`.
import './process-polyfill';
import './buffer-polyfill';
// Inject Papercup's grid palette before any grid renders (grid-core went
// brand-agnostic; see grid-colors.ts).
import './grid-colors';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

const router = createRouter({
  routeTree,
  // Preload routes on hover/focus/touchstart so the loader fires *before*
  // the click. For routes with a loader (e.g. /harness/$slug fetches
  // /api/harness/projects/lite), this means the data is already in TSR's
  // cache by the time the user clicks, and TSR can swap routes instantly
  // instead of holding the old page rendered while the fetch resolves.
  defaultPreload: 'intent',
  // How long after hover/focus before preloading kicks in. Default is
  // 50ms; we keep it tight so any deliberate hover triggers the preload.
  defaultPreloadDelay: 50,
  // If a navigation does block (loader miss, cold lazy chunk), swap to
  // pending UI immediately instead of letting the old route linger.
  // Default is 1000ms — TSR holds the old route until either the new
  // route resolves or pendingMs elapses. Setting 0 means "as soon as
  // we know we're waiting, stop rendering the old route." This kills
  // the ~500ms 'previous page lingers after clicking' artifact.
  defaultPendingMs: 0,
  // Once pending UI appears, how long to hold it at minimum so it
  // doesn't flash for instant resolutions. Default is 500ms; halve it
  // so warm cache feels instant but no flicker for slow loads.
  defaultPendingMinMs: 250,
  // Without a pendingComponent, TSR keeps the old route rendered until
  // the new one resolves — that's the "previous page lingers after
  // clicking" artifact users see. Render `null` (blank content) by
  // default so the page chrome stays, the content area clears, and
  // the top NavigationProgress bar (in __root.tsx) signals "loading."
  // Individual routes can override with their own pendingComponent.
  defaultPendingComponent: () => null,
  // Cache loader results for 5s. The /harness/$slug loader fetches
  // /projects/lite (~5KB, rarely changes); without staleTime, every
  // click on a sibling slug refetches. 5s is enough that quick back-
  // and-forth feels instant but stale data doesn't persist.
  defaultStaleTime: 5_000,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('operator-vite: #root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
