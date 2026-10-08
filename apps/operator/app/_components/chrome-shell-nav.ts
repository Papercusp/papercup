export function isChromeShellNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type ProductWorkspace = 'operations' | 'dao';

/** Only restore this workspace's own local route, never an external URL. */
export function productWorkspaceHref(value: string | null, workspace: ProductWorkspace): string {
  const base = workspace === 'dao' ? '/daos' : '/adv';
  if (!value || !value.startsWith('/') || value.startsWith('//')) return base;
  try {
    const url = new URL(value, 'https://papercusp.invalid');
    if (url.origin !== 'https://papercusp.invalid' || !isChromeShellNavActive(url.pathname, base)) return base;
    return url.pathname + url.search + url.hash;
  } catch {
    return base;
  }
}
