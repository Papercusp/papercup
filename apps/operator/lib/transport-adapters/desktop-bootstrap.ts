/**
 * `installDesktopIpcPolyfills` — Tauri-only install of `IpcEventSource`
 * (as `window.EventSource`) and an `ipcFetch` wrapper (as `window.fetch`
 * for same-origin /api/* requests).
 *
 * After install, every existing consumer that does
 * `new EventSource('/api/...')` or `fetch('/api/...')` — including
 * `createResilientEventSource`, which reads `globalThis.EventSource` —
 * transparently rides the IPC bridge instead of opening a webview HTTP
 * connection. That removes the webview's HTTP-pool-per-host pressure
 * entirely (the connection-pool bug that hangs the live agent-thinking
 * popover on the harness page).
 *
 * Scope:
 *  - Only runs in the Tauri webview (`__TAURI_INTERNALS__.invoke` present).
 *  - Skipped if `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1` — same
 *    kill-switch the tool transport picker honors.
 *  - `fetch` wrapper: same-origin /api/* → ipcFetch; everything else
 *    (cross-origin PostHog/LLM/asset traffic, same-origin non-/api/*)
 *    falls through to the native fetch unchanged.
 *  - `EventSource` install is unconditional once we decide to install
 *    at all. Current consumers are all same-origin /api/*; a future
 *    cross-origin EventSource consumer would surface a `bad_path` error
 *    from the bridge and we'd add a routing wrapper at that point.
 *  - Idempotent: a second call returns null without re-patching.
 */

import { IpcEventSource } from './ipc-event-source';
import { ipcFetch } from './ipc-fetch';

interface InstallHandle {
  uninstall: () => void;
}

let installed = false;

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
      ?.invoke,
  );
}

function forceHttp(): boolean {
  if (typeof process === 'undefined') return false;
  const v = process.env?.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT;
  return v === '1' || v === 'true';
}

function isSameOriginApiPath(url: string | URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const u = new URL(typeof url === 'string' ? url : url.toString(), window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function installDesktopIpcPolyfills(): InstallHandle | null {
  if (typeof window === 'undefined') return null;
  if (installed) return null;
  if (!isTauri() || forceHttp()) return null;

  // Hold both the original reference (for identity-preserving uninstall)
  // and a bound version (for internal use — Tauri webviews tend to keep
  // `this===window` invariant on host objects but `.bind` is cheap
  // insurance).
  const originalFetchRef = window.fetch;
  const originalFetchBound = originalFetchRef.bind(window);
  const OriginalEventSource = window.EventSource;

  // Patch fetch: same-origin /api/* → ipcFetch; everything else native.
  // Reject the Request-form input by falling through to native — Phase 1
  // ipcFetch wants a URL + init, and converting a Request faithfully
  // (especially with a streaming body) is more code than it's worth
  // until a real consumer needs it.
  const patchedFetch: typeof window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
      if (isSameOriginApiPath(input)) {
        return ipcFetch(input, init ?? {});
      }
    }
    return originalFetchBound(input as RequestInfo, init);
  };
  window.fetch = patchedFetch;

  // Patch EventSource. IpcEventSource implements the same interface; a
  // future cross-origin EventSource would surface `bad_path` from the
  // bridge — fix-forward when that consumer appears.
  (window as unknown as { EventSource: typeof window.EventSource }).EventSource =
    IpcEventSource as unknown as typeof window.EventSource;

  installed = true;

  return {
    uninstall: () => {
      window.fetch = originalFetchRef;
      (window as unknown as { EventSource: typeof window.EventSource }).EventSource =
        OriginalEventSource;
      installed = false;
    },
  };
}

/** Internal — tests reset module state. */
export function _resetForTests(): void {
  installed = false;
}
