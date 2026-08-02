'use client';

import { useEffect } from 'react';

/**
 * Suppresses dev-mode auto-reloads.
 *
 * Why: with multiple agents saving files concurrently, the constant
 * Fast Refresh + full reload churn keeps the running page in a half-
 * mounted state. Saving should still recompile (so the next manual
 * reload picks up changes), but the page itself stays put until the
 * developer hits Cmd/Ctrl+R.
 *
 * History (WI-7002): this originally also monkey-patched
 * `window.WebSocket` to drop connections to Next's dev endpoints
 * (`/_next/webpack-hmr`, `/_next/turbopack-hmr`). That block is gone —
 * `apps/operator` is never run as a standalone Next dev server (see the
 * repo-conventions "retired surfaces" list), and the component's only
 * live consumer is `apps/operator-vite/src/routes/__root.tsx` (imported
 * cross-tree via the `@` alias), which is bundled by Vite, not Next —
 * Vite's own HMR socket never matches a `/_next/*` path, so the block
 * never fired there either. It was dead code twice over: unreachable
 * (Next dev never runs) and, even if it had run, ineffective for the
 * one runtime that actually imports this component.
 *
 * Mechanism (what's actually load-bearing): patch `window.location.reload`
 * so any dev-runtime reload call — Vite's HMR client calls it directly on
 * a full-reload signal (see `pageReload`/`debounceReload` in
 * `vite/dist/client/client.mjs`; this Vite version's `vite:beforeFullReload`
 * event is fire-and-forget and cannot itself cancel the reload) — is a
 * no-op instead. The user's manual Cmd/Ctrl+R bypasses JS reload entirely
 * and still works.
 *
 * Toggle: defaults to ON in development. Set `VITE_ENABLE_HMR=1` (a
 * Vite-prefixed env var, exposed via `import.meta.env`) to opt back into
 * auto-reload.
 *
 * Production is untouched — the component returns null immediately when
 * not running in a development-mode build.
 *
 * NOTE (WI-7002): the guard below reads `import.meta.env.MODE`, not
 * `process.env.NODE_ENV`. `vite build` pins `process.env.NODE_ENV` to
 * `'production'` regardless of `--mode`, and the bundler constant-folds
 * that comparison at BUILD time — under the default desktop dev shell
 * (`vite build --watch --mode development`) the old `process.env.NODE_ENV
 * !== 'development'` check was therefore statically `true` in every build,
 * making this whole component permanently inert. `import.meta.env.MODE`
 * correctly reflects `--mode` in every build (dev shell, HMR dev server,
 * and the packaged production build) and isn't subject to that pinning.
 */
export default function DevReloadGate() {
  useEffect(() => {
    if (import.meta.env.MODE !== 'development') return;
    if (import.meta.env.VITE_ENABLE_HMR === '1') return;

    // Patch location.reload so any dev-runtime auto-reload call is
    // suppressed. The user's manual Cmd/Ctrl+R bypasses JS reload
    // entirely and still works.
    //
    // In modern Chromium/WebKit `location.reload` is a non-writable,
    // non-configurable own property — direct assignment throws in
    // strict mode. Use defineProperty and tolerate failure (some
    // embedding contexts may disallow redefining it).
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
      // Browser disallows redefining location.reload — nothing else to
      // fall back to; the gate is simply a no-op in that environment.
    }

    // eslint-disable-next-line no-console
    console.info('[DevReloadGate] auto-reload disabled. Save files freely; hit Cmd/Ctrl+R to load latest. Set VITE_ENABLE_HMR=1 to restore.');

    return () => {
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
