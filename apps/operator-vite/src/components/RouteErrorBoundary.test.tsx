// @vitest-environment jsdom
/**
 * RouteErrorBoundary coverage — the boundary that wraps the route <Outlet/> so a
 * single tab's render throw shows a recoverable card (Reload / Try again / details)
 * instead of latching TanStack's bare root boundary across every tab. Covers: pass-
 * through when children render; the fallback on a caught throw; the WORKING Reload
 * (hardReload); Try-again re-render; the details expand/collapse toggle; and the
 * escape-on-navigate reset (a changed location clears the error).
 *
 * componentDidCatch logs via console.error by design — React also logs the caught
 * error — so every throwing test suppresses console.error (Vitest is fail-on-console).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({ href: '/adv?tab=a', hardReload: vi.fn(), explode: true }));

vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ href: H.href }) }));
vi.mock('@papercusp/operator-core/lib/hard-reload', () => ({ hardReload: H.hardReload }));

import RouteErrorBoundary from './RouteErrorBoundary';

// Throws based on a module-level flag rather than a prop, so a re-render driven by
// the boundary's OWN setState (Try again) re-evaluates the latest flag — exactly
// how a transient cause (a stale chunk that got refetched) clears in production.
function Boom(): React.ReactElement {
  if (H.explode) throw new Error('kaboom in a tab');
  return <div data-testid="happy">all good</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  H.href = '/adv?tab=a';
  // Clear (don't reassign) — the vi.mock factory bound this exact fn reference.
  H.hardReload.mockClear();
  H.explode = true;
});

describe('<RouteErrorBoundary>', () => {
  it('renders children when nothing throws', () => {
    H.explode = false;
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId('happy')).toBeTruthy();
  });

  it('shows the recoverable fallback card when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('This view hit an error')).toBeTruthy();
    expect(screen.getByText('Reload')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    // Stack is hidden until expanded.
    expect(screen.queryByText(/kaboom in a tab/)).toBeNull();
  });

  it('Reload calls hardReload (the desktop-host-safe reload)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Reload'));
    expect(H.hardReload).toHaveBeenCalledTimes(1);
  });

  it('Show details toggles the stack trace open and closed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText(/kaboom in a tab/)).toBeTruthy();
    fireEvent.click(screen.getByText('Hide details'));
    expect(screen.queryByText(/kaboom in a tab/)).toBeNull();
  });

  it('Try again clears the error and re-renders the children once the cause is gone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    // The transient cause clears, THEN Try again re-mounts the children (the
    // boundary's setState re-renders Boom, which now reads explode=false).
    H.explode = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByTestId('happy')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('escapes on navigate: a changed location clears the latched error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    // Navigate (new ?tab=) — the functional wrapper threads the new href as
    // resetKey, so componentDidUpdate clears the error and the new route mounts.
    H.explode = false;
    H.href = '/adv?tab=b';
    rerender(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId('happy')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
