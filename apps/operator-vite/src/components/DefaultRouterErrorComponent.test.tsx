// @vitest-environment jsdom
/**
 * DefaultRouterErrorComponent coverage — the router-level `defaultErrorComponent`
 * (main.tsx) that replaces TanStack's bare "Something went wrong!" for errors
 * TanStack surfaces at the route/root level, INCLUDING a shell lazy chunk's LOAD
 * 404 (LeftSidebar / DevAdminRail / a tab panel outside RouteErrorBoundary's
 * <Outlet/>). Covers: chunk-load errors auto-heal once (hardReload) via the
 * shared 60s sessionStorage debounce; a real render bug never auto-reloads; the
 * debounce blocks a reload loop; the manual Reload button; and `reset` (Try
 * again) rendering only when TanStack provides it. See WI-1484.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({ hardReload: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/hard-reload', () => ({ hardReload: H.hardReload }));

import { CHUNK_AUTO_RELOAD_KEY, DefaultRouterErrorComponent } from './RouteErrorBoundary';

const CHUNK_ERR = new Error('Importing a module script failed.'); // WebKit phrasing
const RENDER_BUG = new TypeError("Cannot read properties of undefined (reading 'map')");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  H.hardReload.mockClear();
  window.sessionStorage.clear();
});

describe('<DefaultRouterErrorComponent>', () => {
  it('auto-heals ONCE on a stale-chunk load failure (hardReload) and stamps the debounce', () => {
    render(<DefaultRouterErrorComponent error={CHUNK_ERR} reset={() => {}} />);
    expect(H.hardReload).toHaveBeenCalledTimes(1);
    // Debounce stamp written so a sibling boundary won't also reload.
    expect(Number(window.sessionStorage.getItem(CHUNK_AUTO_RELOAD_KEY))).toBeGreaterThan(0);
  });

  it('NEVER auto-reloads for an ordinary render bug', () => {
    render(<DefaultRouterErrorComponent error={RENDER_BUG} reset={() => {}} />);
    expect(H.hardReload).not.toHaveBeenCalled();
    // The manual recovery card is still shown.
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('This view hit an error')).toBeTruthy();
  });

  it('debounces: a chunk error within 60s of the last reload does NOT loop', () => {
    // A reload happened just now → the second chunk crash lands on the manual card.
    window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(Date.now()));
    render(<DefaultRouterErrorComponent error={CHUNK_ERR} reset={() => {}} />);
    expect(H.hardReload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('re-heals once the 60s debounce window has elapsed', () => {
    window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(Date.now() - 61_000));
    render(<DefaultRouterErrorComponent error={CHUNK_ERR} reset={() => {}} />);
    expect(H.hardReload).toHaveBeenCalledTimes(1);
  });

  it('manual Reload button calls hardReload (desktop-host-safe)', () => {
    // Use a render bug so the auto-heal doesn't fire — isolates the button.
    render(<DefaultRouterErrorComponent error={RENDER_BUG} reset={() => {}} />);
    fireEvent.click(screen.getByText('Reload'));
    expect(H.hardReload).toHaveBeenCalledTimes(1);
  });

  it('renders Try again only when TanStack provides a reset fn', () => {
    const { rerender } = render(<DefaultRouterErrorComponent error={RENDER_BUG} reset={() => {}} />);
    expect(screen.getByText('Try again')).toBeTruthy();
    rerender(<DefaultRouterErrorComponent error={RENDER_BUG} />);
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('Show details toggles the stack trace', () => {
    render(<DefaultRouterErrorComponent error={RENDER_BUG} reset={() => {}} />);
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText(/Cannot read properties of undefined/)).toBeTruthy();
    fireEvent.click(screen.getByText('Hide details'));
    expect(screen.queryByText(/Cannot read properties of undefined/)).toBeNull();
  });
});
