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
 */
export const CHROMELESS_PREFIXES = ['/pi', '/project-docs', '/el-min', '/quick-panel'] as const;

/** True when `pathname` is (or is nested under) a chromeless route. */
export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
