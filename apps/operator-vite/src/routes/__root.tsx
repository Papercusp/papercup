import { createRootRoute, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';
// Custom nuqs adapter (NOT nuqs/adapters/tanstack-router): the stock adapter
// rebuilds the URL from only nuqs-watched keys, dropping TanStack-native typed
// search params (?dock, ?switch) on every nuqs write. Ours merges over the full
// current search. See ../lib/nuqs-tanstack-router-adapter.
import { NuqsAdapter } from '../lib/nuqs-tanstack-router-adapter';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RootSyncProvider } from '@/app/_components/RootSyncProvider';
import { OperatorConversationProvider } from '@/app/_components/OperatorConversationProvider';
import { PostHogProvider } from '@/app/_components/PostHogProvider';
import WslOnboardingGate from '@/app/_components/WslOnboardingGate';
import GlobalShortcutDispatcher from '@/app/_components/GlobalShortcutDispatcher';
import GlobalNavShortcuts from '@/app/_components/GlobalNavShortcuts';
import GlobalCommandPalette from '@/app/_components/GlobalCommandPalette';
import GlobalShortcutsHelp from '@/app/_components/GlobalShortcutsHelp';
import GlobalAppShortcuts from '@/app/_components/GlobalAppShortcuts';
import GlobalVoiceShortcuts from '@/app/_components/GlobalVoiceShortcuts';
import GlobalSearchDialog from '@/app/_components/GlobalSearchDialog';
import PresenceRail from '@/app/_components/PresenceRail';
// Side effect: register the browser voice controls into operator-core's
// voice-control bridge so voice.* commands reach the UI voice engine without a
// core→@/app back-edge (operator-core stays headless/UI-free).
import '@/lib/commands/voice-controls-entry';
import GlobalFindInPage from '@/app/_components/GlobalFindInPage';
import RouteTransitionProvider from '@/app/_components/RouteTransitionProvider';
import { ToasterSelectionFix } from '@/app/_components/ToasterSelectionFix';
import { ToastHistoryRecorder } from '@/app/_components/ToastHistoryRecorder';
import { HiveThemeBridge } from '@/app/_components/HiveThemeBridge';
import DesktopAttentionNotifier from '@/app/_components/DesktopAttentionNotifier';
import { UiPresenceProvider } from '@/app/_components/UiPresenceProvider';
import DevReloadGate from '@/app/_components/DevReloadGate';
import PerfObserverProvider from '@/app/admin/testing/_components/PerfObserverProvider';
// Universal in-app perf-recorder host (channel/storage-compatible with the
// operator's _lib — same CHANNEL_NAME + localStorage key). Activates only when
// ?perf-recorder=1 is set (the chaos-desktop recorder window). Phase 6 of
// universal-testing-domains-generic-2026-06-03.
import { RecorderHost } from '@papercusp/testing-shell';
import ChromeShell from '@/app/_components/ChromeShell';
import { ProgressProvider } from '@bprogress/react';
import NotFound from '../components/NotFound';
import { NavigationProgress } from '../components/NavigationProgress';
import ChunkReloadPrompt from '../components/ChunkReloadPrompt';
import RouteErrorBoundary from '../components/RouteErrorBoundary';
import '@/app/globals.css';
// App-wide command-palette chrome (⌘K / Ctrl+P). The palette markup uses
// `.h-cmd*` classes that used to live in harness.css; they now live here.
import '@/app/command-palette.css';
// App-wide find-in-page (Ctrl/⌘+F): the ::highlight() rules for the CSS
// Custom Highlight API + the `.pc-find*` find-bar chrome.
import '@/app/find-in-page.css';
// Harness panel styles (the `h-*` classes). The legacy /harness page loaded
// these via HarnessDashboard; now that /adv tabs render harness panel
// components directly (brainstorm/prs/settings/insights — see
// AdvHarnessPanelPage), the shell must load the stylesheet so those panels
// keep their styling without mounting the whole dashboard.
import '@/app/harness/harness.css';

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
 *
 * PORTED to `apps/operator-vite/index.html` (the pre-paint `<head>`/body-start
 * bootstraps that Next ran from layout.tsx; each is client-rendered-SPA-safe
 * and reads the same wsLocalKey-scoped keys the React libs use):
 *   - Color theme — `data-theme` + cached custom-theme CSS.
 *   - Visual-effects mode — `data-visual-effects` / `data-visual-effects-mode`.
 *   - Op-chat width — a body-start classic script plus a `<head>`
 *     `<style id="op-chat-width-reserve">`, since that reservation CSS is
 *     otherwise component-scoped and absent pre-paint.
 */
// Dev-only admin rail (plan dev-admin-sidebar-2026-06-05). Gated on
// `import.meta.env.MODE !== 'production'` HERE so the whole rail — and its
// lazily-imported panels — is statically dead code in a production build: the
// ternary resolves to `null`, the `lazy(() => import(...))` call is never
// emitted, and Rollup drops the chunk (verified: 0 `pcdar`/rail strings in a
// production `vite build`). Result: the rail is ABSENT from user builds (D-001).
//
// Why MODE, not `import.meta.env.DEV` (which the plan named): Vite ties DEV/PROD
// to the COMMAND (`vite` serve vs `vite build`), NOT to `--mode`. The desktop dev
// shell runs `vite build --watch --mode development` — a *build*, so DEV===false
// there, and a DEV gate would make the rail never appear in the desktop. MODE is
// the real discriminator: it's 'development' in BOTH dev shells (nohmr build +
// :3055 HMR serve) and 'production' only in the shipped `vite build`.
const DevAdminRail =
  import.meta.env.MODE !== 'production'
    ? lazy(() => import('../components/dev-admin-rail/DevAdminRail'))
    : null;

// Left sidebar (left-sidebar-tauri-2026-06-07) — the Swarm / Voice / Hives
// rail, the desktop twin of the pui dock's retired main pane. First-class app
// chrome (NOT dev-gated); lazy so the shell paint doesn't pay for its panels.
const LeftSidebar = lazy(() => import('../components/left-sidebar/LeftSidebar'));

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
              {/* App-wide keyboard surfaces — mounted at the router root,
                  above ChromeShell, so Ctrl+P (palette) and Alt+Left/Right
                  (history nav) work on EVERY route, including /settings and
                  the chromeless iframe targets ChromeShell itself skips. */}
              <GlobalNavShortcuts />
              <GlobalCommandPalette />
              <GlobalFindInPage />
              {/* Discord-parity shortcuts (discord-shortcuts 2026-06-06):
                  Mod+/ cheat-sheet, Mod+, settings, Mod+I inbox,
                  Mod+Shift+N create, Mod+Shift+M/D voice mute/deafen,
                  Mod+Shift+F global search, Mod+U live-agents rail. */}
              <GlobalShortcutsHelp />
              <GlobalAppShortcuts />
              <GlobalVoiceShortcuts />
              <GlobalSearchDialog />
              <PresenceRail />
              {/* Left sidebar — Swarm / Voice / Hives (left-sidebar-tauri-
                  2026-06-07). Inside NuqsAdapter (its open/tab/selection state
                  is URL-backed) + RootSyncProvider (its panels use
                  useSyncQuery); docked via body.has-left-sidebar. */}
              <Suspense fallback={null}>
                <LeftSidebar />
              </Suspense>
              <RouteTransitionProvider>
                <WslOnboardingGate>
                  <OperatorConversationProvider>
                    <PostHogProvider>
                      <HiveThemeBridge />
                      {/* Global chrome — header/navbar, left operator-chat
                          sidebar, Oracle dock. Renders before <main>,
                          mirroring the Next operator's layout.tsx.
                          (Deferred in A3 because it imports next/navigation;
                          the alias shim now resolves that.) */}
                      <ChromeShell />
                      <main data-route-transition-page="true">
                        {/* Route-content error boundary: keeps ChromeShell
                            mounted on a route crash (so the user can navigate
                            away), resets on navigation, and offers a working
                            reload. Without it, a route throw bubbled to
                            TanStack's bare root boundary and blanked the whole
                            shell — and because /adv is one route, one tab's
                            crash latched every tab. */}
                        <RouteErrorBoundary>
                          <Outlet />
                        </RouteErrorBoundary>
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
              {/* Desktop-native attention pushes (planning-attention-importance
                  P-020/D-007). Mounted here, not only in the Next layout.tsx —
                  the desktop renders THIS operator-vite SPA, so without it the
                  attention.notify SSE event reaches the webview but nothing
                  turns it into a sonner toast + native OS notification. */}
              <DesktopAttentionNotifier />
              <PerfObserverProvider />
              <RecorderHost />
              {/* Dev-only admin rail — collapsible right cockpit (flags / run /
                  health / deploy-state / db / fleet). Mounted inside NuqsAdapter
                  (its open/section state is nuqs-backed) + RootSyncProvider (its
                  glance panels use useSyncQuery). Absent from production builds —
                  see the DevAdminRail lazy const above. */}
              {DevAdminRail && (
                <Suspense fallback={null}>
                  <DevAdminRail />
                </Suspense>
              )}
              <DevReloadGate />
              <ChunkReloadPrompt />
            </NuqsAdapter>
          </Suspense>
        </ProgressProvider>
      </RootSyncProvider>
    </Tooltip.Provider>
  );
}

