import { getBrowserWorkspaceId } from './browser-workspace';

/**
 * Does `target` switch the window to a workspace other than `currentWorkspaceId`?
 *
 * A workspace change can NEVER be a soft SPA navigation: the operator host
 * (`host-spa`) injects `window.__PAPERCUSP_WS__` from the request's `?ws=` only
 * on a full document load, and `getBrowserWorkspaceId()` prefers that injected
 * global over `?ws=`. So a soft (pushState) nav to a different `?ws` leaves the
 * window stamping the OLD workspace on every fetch/SSE — the "switch reloads to
 * the same workspace" bug. Such navigations must be hard (full reload).
 */
function targetChangesWorkspace(parsed: URL, currentWorkspaceId: string | undefined): boolean {
  if (!currentWorkspaceId) return false;
  const nextWs = parsed.searchParams.get('ws')?.trim();
  return !!nextWs && nextWs !== currentWorkspaceId;
}

export function shouldSoftNavigate(target: string, currentHref = window.location.href): boolean {
  try {
    const current = new URL(currentHref, currentHref);
    const next = new URL(target, currentHref);
    if (!(next.protocol === 'http:' || next.protocol === 'https:')) return false;
    return next.origin === current.origin;
  } catch {
    return false;
  }
}

export function resolveClientNavigation(
  target: string,
  currentHref: string,
  opts?: { replace?: boolean; hard?: boolean; currentWorkspaceId?: string },
): { mode: 'soft' | 'hard' | 'none'; href: string | null; replace: boolean } {
  const replace = Boolean(opts?.replace);
  let parsed: URL;
  try {
    parsed = new URL(target, currentHref);
    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return { mode: 'none', href: null, replace };
    }
  } catch {
    return { mode: 'none', href: null, replace };
  }

  // A forced-hard nav (a workspace switch) or any nav that changes the
  // workspace must do a full document load so the host re-injects
  // `__PAPERCUSP_WS__` — see targetChangesWorkspace.
  if (opts?.hard || targetChangesWorkspace(parsed, opts?.currentWorkspaceId)) {
    return { mode: 'hard', href: parsed.href, replace };
  }

  if (!shouldSoftNavigate(target, currentHref)) {
    return { mode: 'hard', href: parsed.href, replace };
  }

  const href = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return { mode: 'soft', href, replace };
}

/**
 * Perform a GENUINE hard navigation that survives the static desktop host's
 * `location.assign`/`location.replace` override.
 *
 * The desktop host (`apps/operator-vite/index.html`, active on :3070/:4173 —
 * what the packaged desktop webview loads) redefines `location.assign` and
 * `location.replace` to a SAME-ORIGIN soft `pushState`/`replaceState`, so a
 * stray JS navigation can't reload the desktop session mid-task while
 * `vite build --watch` rewrites `dist/`. That override silently downgrades a
 * forced-hard nav (a workspace switch → `/harness?ws=<id>`) to a soft one: the
 * document never reloads, the host never re-injects `window.__PAPERCUSP_WS__`,
 * and `getBrowserWorkspaceId()` keeps returning the OLD workspace — the
 * "switch does nothing" bug.
 *
 * The host stashes the genuine methods on `window` BEFORE installing the
 * overrides (`__papercuspOriginalAssign`/`__papercuspOriginalReplace`, mirroring
 * `__papercuspOriginalReload` — see lib/hard-reload.ts), precisely so a
 * deliberate hard nav can bypass the suppression. The stash + the override are
 * installed together in one try-block (stash first), so the two consistent
 * states are: (a) stash present AND override present → use the stash to bypass;
 * (b) no stash AND no override (off-desktop, or the block aborted) → the native
 * methods are genuine. Either way this reaches a real document load.
 */
function hardNavigate(href: string, replace: boolean): void {
  const w = window as unknown as {
    __papercuspOriginalAssign?: (target: string) => void;
    __papercuspOriginalReplace?: (target: string) => void;
  };
  const stashed = replace ? w.__papercuspOriginalReplace : w.__papercuspOriginalAssign;
  if (typeof stashed === 'function') {
    try {
      stashed(href);
      return;
    } catch {
      /* fall through to the native methods (genuine off-desktop) */
    }
  }
  if (replace) window.location.replace(href);
  else window.location.assign(href);
}

export function navigateClient(target: string, opts?: { replace?: boolean; hard?: boolean }): void {
  if (typeof window === 'undefined') return;
  const action = resolveClientNavigation(target, window.location.href, {
    ...opts,
    currentWorkspaceId: getBrowserWorkspaceId(),
  });
  if (action.mode === 'hard' && action.href) {
    hardNavigate(action.href, action.replace);
    return;
  }
  if (action.mode === 'none') return;

  if (action.replace) window.history.replaceState({}, '', action.href);
  else window.history.pushState({}, '', action.href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
