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

export function navigateClient(target: string, opts?: { replace?: boolean }): void {
  if (typeof window === 'undefined') return;
  if (!shouldSoftNavigate(target, window.location.href)) {
    if (opts?.replace) window.location.replace(target);
    else window.location.assign(target);
    return;
  }

  const next = new URL(target, window.location.href);
  const href = `${next.pathname}${next.search}${next.hash}`;
  if (opts?.replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
