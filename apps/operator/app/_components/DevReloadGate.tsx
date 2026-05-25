'use client';

import { useEffect } from 'react';

/**
 * Suppresses Next.js dev-mode auto-reloads.
 *
 * Why: with multiple agents saving files concurrently, the constant
 * Fast Refresh + full reload churn keeps the running page in a half-
 * mounted state. Saving should still recompile (so the next manual
 * reload picks up changes), but the page itself stays put until the
 * developer hits Cmd/Ctrl+R.
 *
 * Mechanism:
 *   1. Kill any open Next dev WebSocket (turbopack-hmr or older
 *      webpack-hmr endpoint). Closing the socket stops the dev
 *      runtime from receiving the `built` / `sync` messages that
 *      trigger a Fast-Refresh application or full reload.
 *   2. Patch `window.location.reload` so even a stray dev-runtime
 *      reload call is a no-op. The patch logs a console hint instead.
 *
 * Toggle: defaults to ON in development. Set
 * `NEXT_PUBLIC_ENABLE_HMR=1` in the env to opt back into HMR.
 *
 * Production is untouched — the component returns null immediately
 * when NODE_ENV !== 'development'.
 */
export default function DevReloadGate() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    if (process.env.NEXT_PUBLIC_ENABLE_HMR === '1') return;

    // 1. Close the Next dev WebSocket(s). Next exposes the live socket
    //    on `__NEXT_HMR_LATEST_HASH` via a Symbol; the simplest robust
    //    approach is to monkey-patch the WebSocket constructor to drop
    //    any new connection whose URL matches Next's dev endpoints, and
    //    walk any already-open sockets via a brief delayed sweep.
    const blockedHosts = /\/_next\/webpack-hmr|\/_next\/turbopack-hmr/;
    if ((window.WebSocket as unknown as { __papercuspDevReloadGate?: boolean }).__papercuspDevReloadGate) return;
    const OrigWS = window.WebSocket;
    function GatedWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]): WebSocket {
      const str = typeof url === 'string' ? url : url.toString();
      if (blockedHosts.test(str)) {
        // eslint-disable-next-line no-console
        console.info('[DevReloadGate] blocked HMR WebSocket →', str, '(NEXT_PUBLIC_ENABLE_HMR=1 to disable)');
        // Return an inert socket-like object so callers' .addEventListener
        // / .send don't throw. Open it as data: which closes immediately.
        return new OrigWS('data:text/plain,', protocols);
      }
      return new OrigWS(url, protocols);
    }
    GatedWebSocket.prototype = OrigWS.prototype;
    Object.defineProperty(GatedWebSocket, 'CONNECTING', { value: OrigWS.CONNECTING });
    Object.defineProperty(GatedWebSocket, 'OPEN', { value: OrigWS.OPEN });
    Object.defineProperty(GatedWebSocket, 'CLOSING', { value: OrigWS.CLOSING });
    Object.defineProperty(GatedWebSocket, 'CLOSED', { value: OrigWS.CLOSED });
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = GatedWebSocket as unknown as typeof WebSocket;

    // 2. Patch location.reload so any Next dev call to it is suppressed.
    //    The user's manual Cmd/Ctrl+R bypasses JS reload entirely and
    //    still works.
    //
    //    In modern Chromium/WebKit `location.reload` is a non-writable,
    //    non-configurable own property — direct assignment throws in
    //    strict mode. Use defineProperty and tolerate failure: the
    //    WebSocket block above already neutralises Next dev's reload
    //    path; reload-patching is belt-and-braces.
    const origReload = location.reload.bind(location);
    let reloadPatched = false;
    try {
      Object.defineProperty(location, 'reload', {
        configurable: true,
        value: () => {
          // eslint-disable-next-line no-console
          console.info('[DevReloadGate] auto-reload suppressed — Cmd/Ctrl+R to refresh manually');
        },
      });
      reloadPatched = true;
    } catch {
      // Browser disallows redefining location.reload. The WebSocket
      // gate is sufficient on its own.
    }

    // eslint-disable-next-line no-console
    console.info('[DevReloadGate] HMR disabled. Save files freely; hit Cmd/Ctrl+R to load latest. Set NEXT_PUBLIC_ENABLE_HMR=1 to restore.');

    return () => {
      (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = OrigWS;
      if (reloadPatched) {
        try {
          Object.defineProperty(location, 'reload', {
            configurable: true,
            value: origReload,
          });
        } catch {
          // best-effort restore
        }
      }
    };
  }, []);

  return null;
}
