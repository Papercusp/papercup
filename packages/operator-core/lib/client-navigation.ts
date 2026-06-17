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

export function navigateClient(target: string, opts?: { replace?: boolean; hard?: boolean }): void {
  if (typeof window === 'undefined') return;
  const action = resolveClientNavigation(target, window.location.href, {
    ...opts,
    currentWorkspaceId: getBrowserWorkspaceId(),
  });
  if (action.mode === 'hard' && action.href) {
    if (action.replace) window.location.replace(action.href);
    else window.location.assign(action.href);
    return;
  }
  if (action.mode === 'none') return;

  if (action.replace) window.history.replaceState({}, '', action.href);
  else window.history.pushState({}, '', action.href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
