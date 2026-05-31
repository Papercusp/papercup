import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Toaster } from 'sonner';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RootSyncProvider } from './_components/RootSyncProvider';
import ChromeShell from './_components/ChromeShell';
import { OperatorConversationProvider } from './_components/OperatorConversationProvider';
import { PostHogProvider } from './_components/PostHogProvider';
import WslOnboardingGate from './_components/WslOnboardingGate';
import GlobalShortcutDispatcher from './_components/GlobalShortcutDispatcher';
import GlobalNavShortcuts from './_components/GlobalNavShortcuts';
import GlobalCommandPalette from './_components/GlobalCommandPalette';
import RouteProgressProvider from './_components/RouteProgressProvider';
import RouteTransitionProvider from './_components/RouteTransitionProvider';
import { ToasterSelectionFix } from './_components/ToasterSelectionFix';
import { ToastHistoryRecorder } from './_components/ToastHistoryRecorder';
import PerfObserverProvider from './admin/testing/_components/PerfObserverProvider';
import RecorderHost from './admin/testing/_components/RecorderHost';
import DevReloadGate from './_components/DevReloadGate';
import DesktopAttentionNotifier from './_components/DesktopAttentionNotifier';
import { UiPresenceProvider } from './_components/UiPresenceProvider';
import {
  OPERATOR_CHAT_COLLAPSED_WIDTH,
  OPERATOR_CHAT_DEFAULT_WIDTH,
  OPERATOR_CHAT_MIN_WIDTH,
  OPERATOR_CHAT_OPEN_QUERY_KEY,
} from './_components/operator-chat-layout';
import { getAllFlags } from '@papercusp/flags/server';
import '@/lib/flag-bus';
import './globals.css';
// App-wide command-palette chrome (⌘K / Ctrl+P). Global CSS must be
// imported from a layout, not the client component that uses it.
import './command-palette.css';

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

// Set the color theme pre-paint so the first paint matches the saved selection
// (no frost→black flash on reload). Replicates lib/theme.ts: the same
// wsLocalKey scoping (pc:ws:<id>:papercusp.theme) and getBrowserWorkspaceId()
// resolution, so this boot read and the React lib always agree on the key.
// Frost is the :root default; only black (and, from Phase 4, custom:<id>) need
// a data-theme attribute, but we set it unconditionally for symmetry.
const themeBootstrapScript = `
(() => {
  const KEY = 'papercusp.theme';
  const DEFAULT = 'frost';
  const wsId = () => {
    try { if (window.__PAPERCUSP_WS__ && String(window.__PAPERCUSP_WS__).trim()) return window.__PAPERCUSP_WS__; } catch (e) {}
    try { const ws = new URL(window.location.href).searchParams.get('ws'); if (ws && ws.trim()) return ws; } catch (e) {}
    return 'default';
  };
  const valid = (v) => typeof v === 'string' && (v === 'frost' || v === 'black' || (v.indexOf('custom:') === 0 && v.length > 7));
  try {
    let id = window.localStorage.getItem('pc:ws:' + wsId() + ':' + KEY);
    if (!valid(id)) id = DEFAULT;
    document.documentElement.dataset.theme = id;
  } catch (e) {
    document.documentElement.dataset.theme = DEFAULT;
  }
  try {
    const css = window.localStorage.getItem('pc:ws:' + wsId() + ':papercusp.customThemesCss');
    if (css) {
      const st = document.createElement('style');
      st.id = 'pc-custom-themes';
      st.textContent = css;
      document.head.appendChild(st);
    }
  } catch (e) {}
})();
`;

// Bootstrap the operator-chat sidebar offset pre-hydration so the body
// padding (and the .pc-header left/width override) is set before the
// first paint. Without this, every page first paints under the sidebar,
// then jumps right when OperatorChatSidebar's useEffect runs.
//
// Reads the same localStorage width and URL open/closed state the
// sidebar component uses. Adds the has-op-chat body class so CSS that
// gates on it applies immediately, and toggles op-chat-collapsed so
// compact-header rules only apply while the full rail is visible.
//
// Iframe routes (CHROMELESS_PATH_PREFIXES in ChromeShell) are also
// covered: ChromeShell returns null for them, so the sidebar never
// renders and the body class is added but the sidebar element is
// absent — leaving empty padding. Strip it on those routes via the
// same path check, inline:
const operatorChatBootstrapScript = `
(() => {
  try {
    var path = location.pathname || '';
    var chromeless = ['/pi', '/project-docs', '/el-min'];
    var skip = chromeless.some(function (p) { return path === p || path.indexOf(p + '/') === 0; });
    if (skip) return;
    var params = new URLSearchParams(location.search || '');
    var open = params.get('${OPERATOR_CHAT_OPEN_QUERY_KEY}') !== 'false';
    var stored = window.localStorage.getItem('papercusp.operatorChat.width');
    var w = open ? ${OPERATOR_CHAT_DEFAULT_WIDTH} : ${OPERATOR_CHAT_COLLAPSED_WIDTH};
    if (open && stored) {
      var n = Number(stored);
      if (Number.isFinite(n) && n >= ${OPERATOR_CHAT_MIN_WIDTH}) {
        var ceiling = Math.max(${OPERATOR_CHAT_MIN_WIDTH}, Math.floor(window.innerWidth * 0.75));
        w = Math.min(n, ceiling);
      }
    }
    document.documentElement.style.setProperty('--op-chat-w', w + 'px');
    if (document.body) {
      document.body.classList.add('has-op-chat');
      document.body.classList.toggle('op-chat-collapsed', !open);
    }
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
  // React 19 emits a dev-only "Encountered a script tag while rendering
  // React component" warning for any <script> we render in JSX. The
  // warning is misleading here: these are SSR-only inline scripts that
  // run when the browser parses the HTML, BEFORE React hydrates — they
  // are not skipped. Patch console.error first so the warning never
  // reaches the console; everything else passes through untouched.
  // Production builds skip the warning anyway (NODE_ENV === 'production').
  // Two filters live in one patch:
  //   1. React 19's "Encountered a script tag" dev-only warning (see
  //      preceding comment block).
  //   2. Tauri's `IPC custom protocol failed, Tauri will now use the
  //      postMessage interface instead` console.warn. On WebKitGTK the
  //      fetch-to-custom-protocol path always fails the first call,
  //      Tauri sets an internal `customProtocolIpcFailed` flag, and
  //      every subsequent IPC uses postMessage — so the warning is
  //      one-shot, expected, and not actionable for app code. Silence
  //      it so it doesn't show up in the dev console as a "real" error.
  //      The filter checks the message text, so any other genuine
  //      Tauri warning still passes through.
  const consolePatchScript = `(function(){
    var DROP_NEEDLES = [
      'Encountered a script tag while rendering React component',
      'IPC custom protocol failed, Tauri will now use the postMessage interface instead',
      // Next's RSC prefetch loses races against Turbopack's per-route
      // lazy-compile in this monorepo; WebKitGTK aborts the slow fetch
      // and Next logs this graceful-degradation message. The fallback
      // (regular browser navigation) works fine — no user-visible
      // failure — so the console line is just dev-mode noise.
      'Failed to fetch RSC payload for',
    ];
    function shouldDrop() {
      // Match any string argument — React's printWarning uses format
      // strings ("%s%s", msg, stack) so the message can be in args[1+].
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (typeof a !== 'string') continue;
        for (var j = 0; j < DROP_NEEDLES.length; j++) {
          if (a.indexOf(DROP_NEEDLES[j]) !== -1) return true;
        }
      }
      return false;
    }
    var origErr = console.error;
    console.error = function(){ if (shouldDrop.apply(null, arguments)) return; return origErr.apply(console, arguments); };
    var origWarn = console.warn;
    console.warn = function(){ if (shouldDrop.apply(null, arguments)) return; return origWarn.apply(console, arguments); };

    // Dev-only: block Next's HMR socket before React hydrates. The client
    // DevReloadGate also does this, but it mounts after Next's dev runtime
    // has already had a chance to connect and apply a full-page refresh.
    // In the shared Tauri shell, automatic HMR reloads look like constant
    // refreshing while other agents save files.
    (function () {
      if (typeof window === 'undefined') return;
      if (window.__PAPERCUSP_ALLOW_HMR__ === '1') return;
      var blockedHosts = /\\/_next\\/webpack-hmr|\\/_next\\/turbopack-hmr/;
      var OrigWS = window.WebSocket;
      if (!OrigWS || OrigWS.__papercuspDevReloadGate) return;
      function GatedWebSocket(url, protocols) {
        var str = typeof url === 'string' ? url : String(url);
        if (blockedHosts.test(str)) {
          try { console.info('[DevReloadGate] blocked pre-hydration HMR WebSocket →', str); } catch (_) {}
          try { return new OrigWS('wss://127.0.0.1:9/__papercusp-hmr-blocked__', protocols); } catch (_) {
            return new OrigWS(url, protocols);
          }
        }
        return new OrigWS(url, protocols);
      }
      GatedWebSocket.prototype = OrigWS.prototype;
      try {
        Object.defineProperty(GatedWebSocket, 'CONNECTING', { value: OrigWS.CONNECTING });
        Object.defineProperty(GatedWebSocket, 'OPEN', { value: OrigWS.OPEN });
        Object.defineProperty(GatedWebSocket, 'CLOSING', { value: OrigWS.CLOSING });
        Object.defineProperty(GatedWebSocket, 'CLOSED', { value: OrigWS.CLOSED });
        Object.defineProperty(GatedWebSocket, '__papercuspDevReloadGate', { value: true });
      } catch (_) {}
      window.WebSocket = GatedWebSocket;
    })();

    // Dev-only: turbopack rebuilds invalidate chunk hashes; a previously
    // mounted page may hold a stale chunk reference for the next lazy()
    // mount. Do NOT auto-reload here in the Tauri dev shell: multiple
    // agents save files continuously, and an automatic recovery reload can
    // become an infinite visible refresh loop. Surface the stale chunk in
    // the console and let the developer choose Cmd/Ctrl+R when they want
    // to pick up the latest build.
    function isChunkErr(e) {
      var msg = (e && (e.message || (e.reason && e.reason.message))) || '';
      var name = (e && (e.name || (e.error && e.error.name) || (e.reason && e.reason.name))) || '';
      if (name === 'ChunkLoadError') return true;
      return /Failed to (load|fetch) chunk|Loading chunk \\d+ failed/i.test(msg);
    }
    function recover() {
      try {
        console.info('[DevReloadGate] stale chunk detected; auto-reload suppressed — Cmd/Ctrl+R to refresh manually');
      } catch (_) {}
      return true;
    }

    window.addEventListener('error', function (e) {
      if (isChunkErr(e)) { try { e.preventDefault(); e.stopImmediatePropagation(); } catch (_) {} recover(); }
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      if (isChunkErr(e)) { try { e.preventDefault(); } catch (_) {} recover(); }
    }, true);
  })();`;
  const flagBootstrapScript = `window.__PAPERCUSP_FLAGS__=${JSON.stringify(flagPayload)};`;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Bootstrap scripts run synchronously at parse time so the first
            paint matches saved state. They are rendered in <head> so they
            execute before any other script. The console-error filter is
            FIRST so subsequent React 19 hydration warnings about us
            rendering these very scripts get dropped. */}
        <script id="papercusp-console-patch" dangerouslySetInnerHTML={{ __html: consolePatchScript }} />
        <script id="papercusp-flags-bootstrap" dangerouslySetInnerHTML={{ __html: flagBootstrapScript }} />
        <script id="papercusp-visual-effects-bootstrap" dangerouslySetInnerHTML={{ __html: visualEffectsBootstrapScript }} />
        <script id="papercusp-theme-bootstrap" dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <script id="papercusp-op-chat-bootstrap" dangerouslySetInnerHTML={{ __html: operatorChatBootstrapScript }} />
      </head>
      {/* suppressHydrationWarning on <body>: the operator-chat
          bootstrap script (in <head> above) adds the `has-op-chat` class
          + sets the --op-chat-w CSS var BEFORE React hydrates so
          the first paint isn't under the sidebar. Server output
          can't include that class (no localStorage server-side),
          so React would log a hydration mismatch. The class is
          purely visual scaffolding — no React state depends on
          it — so suppression is safe. */}
      <body suppressHydrationWarning>
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
                  {/* App-wide keyboard surfaces. Both sit inside
                      <NuqsAdapter> (the palette stores its open state in
                      the URL) and above ChromeShell so they're mounted on
                      EVERY route — including /settings and chromeless
                      iframe targets that ChromeShell itself skips. */}
                  <GlobalNavShortcuts />
                  <GlobalCommandPalette />
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
                  <DesktopAttentionNotifier />
                  <PerfObserverProvider />
                  <RecorderHost />
                  <DevReloadGate />
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
