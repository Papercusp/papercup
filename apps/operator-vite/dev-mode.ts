// Served as `/@vite/client` when desktop HMR is disabled (see
// `shouldServeNoopViteClient`). It CANNOT be empty: even with `server.hmr:
// false`, the TanStack Router plugin (and potentially others) still inject
//   import { createHotContext as __vite__createHotContext } from "/@vite/client";
//   import.meta.hot = __vite__createHotContext("/src/routes/…");
// into route modules. An empty stub exports no `createHotContext`, so the
// webview throws `SyntaxError: Importing binding name 'createHotContext' is not
// found` and white-screens the whole app. So serve a *functional* no-op
// client: the bindings exist and `import.meta.hot` is an inert stub (no
// WebSocket, no reload), so every `if (import.meta.hot)` HMR block runs
// harmlessly against no-ops. (Real HMR opts in via PAPERCUSP_ENABLE_HMR=1,
// which serves Vite's real client instead.)
export const NO_VITE_CLIENT_BODY = `/* Papercusp desktop dev: Vite HMR client disabled — inert no-op client. */
const noop = () => {};
export function createHotContext() {
  return {
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    invalidate: noop,
    decline: noop,
    on: noop,
    off: noop,
    send: noop,
    data: {},
  };
}
export function injectQuery(url) { return url; }
export function updateStyle() {}
export function removeStyle() {}
`;
import { shouldSuppressStaticDesktopReload } from '@papercusp/operator-core/lib/ui/desktop-static-host';

export function isDesktopHmrEnabled(env: Record<string, string | undefined>): boolean {
  return env.PAPERCUSP_ENABLE_HMR === '1' || env.NEXT_PUBLIC_ENABLE_HMR === '1';
}

export function shouldServeNoopViteClient(url: string | undefined, enableHmr: boolean): boolean {
  return !enableHmr && typeof url === 'string' && url.startsWith('/@vite/client');
}

export function shouldSuppressJsReload(origin: string): boolean {
  return shouldSuppressStaticDesktopReload(origin);
}

export function shouldInterceptStaticAnchor(targetHref: string, currentHref: string): boolean {
  if (!shouldSuppressJsReload(new URL(currentHref).origin)) return false;
  try {
    const current = new URL(currentHref);
    const next = new URL(targetHref, currentHref);
    if (!(next.protocol === 'http:' || next.protocol === 'https:')) return false;
    return next.origin === current.origin;
  } catch {
    return false;
  }
}

export function shouldInterceptStaticAnchorClick(opts: {
  targetHref: string;
  currentHref: string;
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  download: boolean;
  targetBlank: boolean;
}): boolean {
  if (opts.defaultPrevented) return false;
  if (opts.button !== 0) return false;
  if (opts.metaKey || opts.ctrlKey || opts.shiftKey || opts.altKey) return false;
  if (opts.download || opts.targetBlank) return false;
  return shouldInterceptStaticAnchor(opts.targetHref, opts.currentHref);
}
