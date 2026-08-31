/**
 * Chromeless routes — the single source of truth for which routes render with
 * NO global app chrome (no env-switcher bar, no ChromeShell header + operator
 * chat sidebar, no left / dev-admin rails). They are bare embedded surfaces:
 *
 *   - `/pi`, `/el-min`   — iframe targets embedded elsewhere in the app.
 *   - `/project-docs`    — the embedded docs view.
 *   - `/quick-panel`     — the desktop's Quick Panel popup window
 *     (papercusp-desktop `src-tauri/src/docs_search.rs` loads this route into a
 *     small always-on-top window; it must be JUST the tabbed panel, not the
 *     whole operator). `npm run dev:quickpanel` also navigates the main window
 *     here for a standalone preview.
 *
 * `__root.tsx` gates the visible chrome on `isChromelessPath`, and the
 * LeftSidebar / DevAdminRail self-suppress on it. Previously each of those
 * carried its own private `CHROMELESS_PREFIXES` copy AND ChromeShell / the env
 * bar had none — so `/quick-panel` still rendered the full app inside the popup.
 *
 * Home: this lives in `operator-core` (not the operator-vite SPA) because the
 * Quick Panel WINDOW-SANDBOX guard in `client-navigation.ts` — a lower layer the
 * SPA depends on — also needs to know "is this a chromeless route" to decide
 * whether a navigation is LEAVING the panel's sandbox (WI-4827). The SPA imports
 * this same module, so there is exactly one list.
 */
export const CHROMELESS_PREFIXES = ['/pi', '/project-docs', '/el-min', '/quick-panel'] as const;

/** True when `pathname` is (or is nested under) a chromeless route. */
export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Portal-hosted /adv documents use a query contract rather than a new route:
 * the portal rail owns navigation while the operator contributes the page and
 * its Papercup chat dock. Keep this predicate next to the ordinary chromeless
 * list so every shell layer agrees on the same boundary.
 */
export function isPortalEmbedLocation(pathname: string, search = ''): boolean {
  if (pathname !== '/adv' && !pathname.startsWith('/adv/')) return false;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('portalEmbed');
  return value === '' || value === '1' || value === 'true' || value === 'yes';
}
