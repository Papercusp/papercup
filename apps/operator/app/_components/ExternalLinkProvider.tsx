'use client';

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/app/_components/SetupWizard/tauri-detect';

/** Hostnames that ARE the app itself (any port) — never externalized. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Whether a clicked link points OUT of the app and should open in the OS default
 * browser instead of navigating the Tauri webview. A same-window nav to an
 * external origin replaces the whole SPA, and a desktop window has no back
 * button — so this returns true only for an http(s) URL to a non-local host on a
 * different origin than the app. Everything else (same-origin, a local host/port,
 * mailto:, the papercusp:// custom scheme, an unparseable href) returns false and
 * is left to default handling. Pure — exported for unit tests.
 */
export function isExternalWebUrl(href: string, currentHref: string): boolean {
  let target: URL;
  let current: URL;
  try {
    target = new URL(href);
    current = new URL(currentHref);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (LOCAL_HOSTS.has(target.hostname)) return false;
  return target.origin !== current.origin;
}

/**
 * ExternalLinkProvider — a global, capture-phase click interceptor that routes
 * EXTERNAL links to the OS default browser via the Tauri shell plugin, so an
 * external `<a>` (e.g. a GitHub link in the Insights tab) never replaces the SPA
 * inside the desktop webview (where there is no back button to recover). This is
 * an app-wide fix, not per-link — every external anchor in the app is covered.
 *
 * No-op outside the desktop shell (`isTauri()` false): a plain browser handles
 * external links fine (new tab / back button), so we let the default happen.
 * Mirrors RouteTransitionProvider's capture-phase document listener. Renders
 * nothing — mount it once, anywhere in the tree.
 *
 * Opens via the core `invoke('plugin:shell|open', …)` — the exact command that
 * `@tauri-apps/plugin-shell`'s `open()` wraps — so no extra JS dependency is
 * needed. The Rust `tauri-plugin-shell` is registered and `shell:allow-open` is
 * granted (papercusp-desktop/src-tauri).
 */
export default function ExternalLinkProvider() {
  useEffect(() => {
    if (!isTauri()) return;
    function handleClickCapture(event: MouseEvent) {
      // Let modified / non-primary clicks and already-handled events through.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      // `anchor.href` is always the resolved ABSOLUTE url for an <a href>.
      if (!anchor || anchor.hasAttribute('download')) return;
      if (!isExternalWebUrl(anchor.href, window.location.href)) return;

      // Keep the SPA put; hand the URL to the OS browser instead.
      event.preventDefault();
      void invoke('plugin:shell|open', { path: anchor.href }).catch((err: unknown) => {
        console.error('[ExternalLinkProvider] shell open failed', err);
      });
    }

    document.addEventListener('click', handleClickCapture, { capture: true });
    return () => document.removeEventListener('click', handleClickCapture, { capture: true });
  }, []);

  return null;
}
