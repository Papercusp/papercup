import { Component, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';

/**
 * Error boundary around the route content (`<Outlet/>`).
 *
 * Why this exists: a render error thrown by a route used to bubble to
 * TanStack's bare root "Something went wrong!" boundary, which replaced the
 * WHOLE shell (ChromeShell included) with a dead end — no reload, no way out.
 * And because `/adv` is a single route (its tabs are just `?tab=`), one tab's
 * throw latched the boundary for *every* tab.
 *
 * Wrapping just the Outlet (ChromeShell is a sibling, outside this boundary)
 * keeps the chrome mounted, and `resetKey` (the location) clears the error on
 * navigation — so changing `?tab=` escapes a crashed tab instead of staying
 * stuck. The fallback offers a WORKING reload: `hardReload()` bypasses the
 * desktop host's reload suppression, and the usual cause here is a stale
 * bundle after `vite build --watch` rewrote `dist/` underneath the page.
 */
interface Props {
  children: ReactNode;
  /** Changing this (the location) clears a caught error — escape-on-navigate. */
  resetKey: string;
}
interface State {
  error: Error | null;
  expanded: boolean;
}

/** Chunk-load failures = the page predates the current build (a lazy tab's
 *  hashed chunk 404s after `vite build --watch` rewrote dist/). Exported for
 *  tests. Webkit says "Importing a module script failed"; Chromium/Firefox
 *  have their own phrasings. */
export const CHUNK_LOAD_ERROR_RE =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;
/** SessionStorage key holding the last chunk-auto-reload timestamp. SHARED by
 *  RouteErrorBoundary (Outlet) + DefaultRouterErrorComponent (root) so the two
 *  boundaries share ONE 60s debounce and can't double-reload. Exported for tests. */
export const CHUNK_AUTO_RELOAD_KEY = 'pcusp-chunk-autoreload-at';

/** Should a chunk-shaped error auto-reload NOW? One shot per window (60s
 *  debounce via sessionStorage) so a genuinely-broken build can't reload-loop.
 *  Pure over its inputs; exported for tests. */
export function shouldAutoReloadForChunkError(
  error: unknown,
  nowMs: number,
  lastReloadAtMs: number,
): boolean {
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  if (!CHUNK_LOAD_ERROR_RE.test(msg)) return false;
  return nowMs - lastReloadAtMs > 60_000;
}

class RouteErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null, expanded: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    // Navigated since the error was caught → clear it and re-render the new
    // route. If the new route also throws, getDerivedStateFromError re-sets it
    // (resetKey is now stable, so no loop).
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, expanded: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[RouteErrorBoundary] caught render error:', error, info.componentStack);
    // Stale-chunk AUTO-HEAL (2026-07-01): a long-open window whose lazy tab
    // chunk 404s after a rebuild used to sit on "Something went wrong" until a
    // human clicked Reload — the owner hit this as "why don't I see Overwatch
    // running?" (the tab was fine; the window predated the rebuild). Reload
    // once automatically; the sessionStorage debounce means a build that is
    // ACTUALLY broken still lands on the manual fallback instead of looping.
    try {
      const last = Number(window.sessionStorage.getItem(CHUNK_AUTO_RELOAD_KEY) ?? 0);
      if (shouldAutoReloadForChunkError(error, Date.now(), last)) {
        window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(Date.now()));
        hardReload();
      }
    } catch {
      /* sessionStorage unavailable → manual fallback stays */
    }
  }

  render(): ReactNode {
    const { error, expanded } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={WRAP}>
        <div style={CARD}>
          <h2 style={TITLE}>This view hit an error</h2>
          <p style={BODY}>
            Often this just means the app was rebuilt underneath the page — the
            dev build watcher rewrote the bundle, so an already-open view can no
            longer load part of itself. Reloading picks up the latest build. If
            it persists after a reload, it&rsquo;s a real bug; the details are
            below.
          </p>
          <div style={ROW}>
            <button type="button" style={PRIMARY} onClick={() => hardReload()}>
              Reload
            </button>
            <button
              type="button"
              style={SECONDARY}
              onClick={() => this.setState({ error: null, expanded: false })}
            >
              Try again
            </button>
            <button
              type="button"
              style={LINK}
              onClick={() => this.setState((s) => ({ expanded: !s.expanded }))}
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {expanded && <pre style={PRE}>{String(error.stack || error.message || error)}</pre>}
        </div>
      </div>
    );
  }
}

/**
 * Functional wrapper: feeds the current location as `resetKey` so the class
 * boundary clears on navigation (class components can't use hooks).
 */
export default function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <RouteErrorBoundaryInner resetKey={location.href}>{children}</RouteErrorBoundaryInner>
  );
}

/**
 * Router-level default error component — wired as `createRouter({
 * defaultErrorComponent })` in `main.tsx`.
 *
 * Why this exists (2026-07-01, WI-1484): `RouteErrorBoundary` above wraps ONLY
 * the `<Outlet/>`. `ChromeShell` / `LeftSidebar` / `DevAdminRail` / tab panels
 * are SIBLINGS outside it, several in bare `<Suspense fallback={null}>` with no
 * error boundary. When one of THEIR lazy chunks 404s — the page predates a
 * rebuild that deleted it (a one-shot `vite build` wiped `dist/` while no watch
 * singleton held the retain-lock, or the retain TTL elapsed, or a production
 * redeploy rolled the hashes) — TanStack surfaces the LOAD failure at the root
 * route's CatchBoundary, NOT at `RouteErrorBoundary`. With no
 * `defaultErrorComponent` set that dead-ended on TanStack's bare "Something
 * went wrong!" with no working reload (the owner hit this as a blank/broken
 * desktop after the bundle was rebuilt underneath the open window).
 *
 * Same chunk-aware auto-heal as `RouteErrorBoundary`, at the layer that
 * actually catches this failure: reload ONCE (60s-debounced via the SHARED
 * `CHUNK_AUTO_RELOAD_KEY`, so the two boundaries can't double-reload) to pick up
 * the fresh build; a genuinely broken build lands on the manual Reload fallback
 * instead of looping. `reset` is TanStack's retry (re-attempts the route).
 */
export function DefaultRouterErrorComponent({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try {
      const last = Number(window.sessionStorage.getItem(CHUNK_AUTO_RELOAD_KEY) ?? 0);
      if (shouldAutoReloadForChunkError(error, Date.now(), last)) {
        window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(Date.now()));
        hardReload();
      }
    } catch {
      /* sessionStorage unavailable → manual fallback stays */
    }
  }, [error]);
  const err = error as { stack?: string; message?: string } | null;
  return (
    <div role="alert" style={WRAP}>
      <div style={CARD}>
        <h2 style={TITLE}>This view hit an error</h2>
        <p style={BODY}>
          Often this just means the app was rebuilt underneath the page — the
          dev build watcher rewrote the bundle, so an already-open view can no
          longer load part of itself. Reloading picks up the latest build. If it
          persists after a reload, it&rsquo;s a real bug; the details are below.
        </p>
        <div style={ROW}>
          <button type="button" style={PRIMARY} onClick={() => hardReload()}>
            Reload
          </button>
          {reset && (
            <button type="button" style={SECONDARY} onClick={() => reset()}>
              Try again
            </button>
          )}
          <button type="button" style={LINK} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        </div>
        {expanded && <pre style={PRE}>{String(err?.stack || err?.message || error)}</pre>}
      </div>
    </div>
  );
}

const WRAP: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  minHeight: '60vh',
  padding: 24,
};
const CARD: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  background: 'var(--bg-2, #0b1220)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 12,
  padding: '22px 24px',
  color: 'var(--fg, #e7f7ff)',
  boxShadow: '0 18px 54px rgba(0,0,0,0.5)',
};
const TITLE: CSSProperties = { margin: '0 0 8px', fontSize: 16, fontWeight: 600 };
const BODY: CSSProperties = {
  margin: '0 0 16px',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--fg-dim, #b9d4e8)',
};
const ROW: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
const PRIMARY: CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  fontWeight: 600,
  color: '#06121b',
  background: 'var(--accent, #57d7ff)',
  border: '1px solid var(--accent, #57d7ff)',
  borderRadius: 6,
  cursor: 'pointer',
};
const SECONDARY: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  color: 'var(--fg, #e7f7ff)',
  background: 'transparent',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  cursor: 'pointer',
};
const LINK: CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  color: 'var(--fg-mute, #7f9bb4)',
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  textDecoration: 'underline',
};
const PRE: CSSProperties = {
  marginTop: 14,
  padding: 12,
  maxHeight: 220,
  overflow: 'auto',
  fontSize: 11,
  lineHeight: 1.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--fg-mute, #9bb3c7)',
  background: 'color-mix(in srgb, var(--bg-deeper, #060b12), transparent 0%)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
