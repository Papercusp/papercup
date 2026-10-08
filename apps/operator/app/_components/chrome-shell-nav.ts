export function isChromeShellNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type ProductWorkspace = 'operations' | 'dao';

export function isDaoWorkspacePath(pathname: string): boolean {
  return isChromeShellNavActive(pathname, '/daos') || isChromeShellNavActive(pathname, '/dao');
}

/** Only restore this workspace's own local route, never an external URL. */
export function productWorkspaceHref(value: string | null, workspace: ProductWorkspace): string {
  const base = workspace === 'dao' ? '/daos' : '/adv';
  if (!value || !value.startsWith('/') || value.startsWith('//')) return base;
  try {
    const url = new URL(value, 'https://papercusp.invalid');
    const belongs = workspace === 'dao' ? isDaoWorkspacePath(url.pathname) : isChromeShellNavActive(url.pathname, base);
    if (url.origin !== 'https://papercusp.invalid' || !belongs) return base;
    return url.pathname + url.search + url.hash;
  } catch {
    return base;
  }
}
