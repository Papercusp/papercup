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
  opts?: { replace?: boolean },
): { mode: 'soft' | 'hard' | 'none'; href: string | null; replace: boolean } {
  const replace = Boolean(opts?.replace);
  try {
    const parsed = new URL(target, currentHref);
    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return { mode: 'none', href: null, replace };
    }
  } catch {
    return { mode: 'none', href: null, replace };
  }

  if (!shouldSoftNavigate(target, currentHref)) {
    return { mode: 'hard', href: target, replace };
  }

  const next = new URL(target, currentHref);
  const href = `${next.pathname}${next.search}${next.hash}`;
  return { mode: 'soft', href, replace };
}

export function navigateClient(target: string, opts?: { replace?: boolean }): void {
  if (typeof window === 'undefined') return;
  const action = resolveClientNavigation(target, window.location.href, opts);
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
