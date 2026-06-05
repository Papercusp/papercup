import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
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
