import type { Metadata } from 'next';
import { Suspense } from 'react';
import Script from 'next/script';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RootSyncProvider } from './_components/RootSyncProvider';
import ChromeShell from './_components/ChromeShell';
import { OperatorConversationProvider } from './_components/OperatorConversationProvider';
import { PostHogProvider } from './_components/PostHogProvider';
import WslOnboardingGate from './_components/WslOnboardingGate';
import GlobalShortcutDispatcher from './_components/GlobalShortcutDispatcher';
import RouteProgressProvider from './_components/RouteProgressProvider';
import RouteTransitionProvider from './_components/RouteTransitionProvider';
import { ToasterSelectionFix } from './_components/ToasterSelectionFix';
import { ToastHistoryRecorder } from './_components/ToastHistoryRecorder';
import PerfObserverProvider from './admin/testing/_components/PerfObserverProvider';
import RecorderHost from './admin/testing/_components/RecorderHost';
import { UiPresenceProvider } from './_components/UiPresenceProvider';
import { getAllFlags } from '@papercusp/flags/server';
import '@/lib/flag-bus';
import './globals.css';

const visualEffectsBootstrapScript = `
(() => {
  const key = 'papercusp.visualEffectsMode';
  const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
  try {
    let mode = window.localStorage.getItem(key);
    if (mode !== 'system' && mode !== 'full' && mode !== 'minimal') mode = 'system';
    const reduced = mode === 'system'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(reducedMotionQuery).matches;
    const effective = mode === 'minimal' || reduced ? 'minimal' : 'full';
    document.documentElement.dataset.visualEffects = effective;
    document.documentElement.dataset.visualEffectsMode = mode;
  } catch {
    document.documentElement.dataset.visualEffects = 'full';
    document.documentElement.dataset.visualEffectsMode = 'system';
  }
})();
`;

// Bootstrap the operator-chat sidebar width pre-hydration so the body
// padding (and the .pc-header left/width override) is set before the
// first paint. Without this, every page first paints under the sidebar,
// then jumps right when OperatorChatSidebar's useEffect runs.
//
// Reads the same localStorage key the sidebar component writes
// (papercusp.operatorChat.width); falls back to 360px. Adds the
// has-op-chat body class so CSS that gates on it applies immediately.
//
// Iframe routes (CHROMELESS_PATH_PREFIXES in ChromeShell) are also
// covered: ChromeShell returns null for them, so the sidebar never
// renders and the body class is added but the sidebar element is
// absent — leaving 360px of empty padding. Strip it on those routes
// via the same path check, inline:
const operatorChatBootstrapScript = `
(() => {
  try {
    var path = location.pathname || '';
    var chromeless = ['/pi', '/project-docs', '/el-min'];
    var skip = chromeless.some(function (p) { return path === p || path.indexOf(p + '/') === 0; });
    if (skip) return;
    var stored = window.localStorage.getItem('papercusp.operatorChat.width');
    var w = 360;
    if (stored) {
      var n = Number(stored);
      if (Number.isFinite(n) && n >= 360) {
        var ceiling = Math.max(360, Math.floor(window.innerWidth * 0.75));
        w = Math.min(n, ceiling);
      }
    }
    document.documentElement.style.setProperty('--op-chat-w', w + 'px');
    document.body && document.body.classList.add('has-op-chat');
  } catch (_) {}
})();
`;

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SSR-resolve the flag payload so first paint matches final state — no
  // flash of a cut feature briefly rendering before the client cache
  // hydrates. We pass distinctId='ssr-bootstrap' which is fine because
  // none of our flags are user-targeted; they're binary across the
  // whole operator instance.
  const flagPayload = await getAllFlags('ssr-bootstrap');
  const flagBootstrapScript = `window.__PAPERCUSP_FLAGS__=${JSON.stringify(flagPayload)};`;
  return (
    <html lang="en" suppressHydrationWarning>
      {/* suppressHydrationWarning on <body>: the operator-chat
          bootstrap script (below) adds the `has-op-chat` class
          + sets the --op-chat-w CSS var BEFORE React hydrates so
          the first paint isn't under the sidebar. Server output
          can't include that class (no localStorage server-side),
          so React would log a hydration mismatch. The class is
          purely visual scaffolding — no React state depends on
          it — so suppression is safe. */}
      <body suppressHydrationWarning>
        <Script id="papercusp-flags-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: flagBootstrapScript }} />
        <Script id="papercusp-visual-effects-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: visualEffectsBootstrapScript }} />
        <Script id="papercusp-op-chat-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: operatorChatBootstrapScript }} />
        <div id="papercusp-app">
          {/* Tooltip.Provider hoisted to the root so ChromeShell-rendered
              children (OperatorPanel, OracleDock) can use the harness/Tooltip
              wrapper without each route layout having to install its own
              provider. The /harness and /pi sub-layouts had their own providers
              historically — those are now redundant but harmless (Radix allows
              nested providers). */}
          <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
            {/* HarnessZeroProvider hoisted to root via RootSyncProvider
                so every component (root-mounted or under /harness/*) can
                use useSyncQuery uniformly. Was previously blocked by a
                Turbopack chunking bug; resolved by Paperclip's commit
                8eeb334 (PhaseTabs node:fs leak fix). */}
            <RootSyncProvider>
            <RouteProgressProvider>
              <GlobalShortcutDispatcher />
              <Suspense fallback={null}>
                <NuqsAdapter>
                  {/* UiPresenceProvider: mirrors this tab's URL to
                      harness_shared.ui_clients and SSE-subscribes for
                      agent-driven UI intents. Inside NuqsAdapter so the
                      built-in `set_url` intent triggers nuqs's URL
                      subscription. See docs/ui-control-plan.md. */}
                  <UiPresenceProvider />
                  <RouteTransitionProvider>
                    <WslOnboardingGate>
                      {/* OperatorConversationProvider owns the
                          continuous-conversation state machine that
                          drives the always-on left chat sidebar. Mounted
                          above ChromeShell so both ChromeShell-rendered
                          sidebar and any future consumers (voice path,
                          set_mode tag dispatcher) see the same context. */}
                      <OperatorConversationProvider>
                        <PostHogProvider>
                          <ChromeShell />
                          <main data-route-transition-page="true">{children}</main>
                        </PostHogProvider>
                      </OperatorConversationProvider>
                    </WslOnboardingGate>
                  </RouteTransitionProvider>
                {/* Single app-wide Toaster, outside <main> so toasts can stack
                    above pc-header (z:1300) and OracleDock (z:80). Sub-pages
                    must not mount their own — those are trapped inside
                    <main z:70> and can't visually escape regardless of
                    inline z-index. */}
                  {/* `closeButton` adds an explicit ✕ since we suppress the
                      drag-to-dismiss gesture below. The actual selection fix
                      lives in <ToasterSelectionFix /> — see the comment on
                      that component for why it's necessary. */}
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
                </NuqsAdapter>
              </Suspense>
            </RouteProgressProvider>
            </RootSyncProvider>
          </Tooltip.Provider>
        </div>
      </body>
      </html>
  );
}
