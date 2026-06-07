// @vitest-environment jsdom
//
// Dev admin rail × REAL router integration — regression for "clicking any
// button inside the rail closes the whole rail".
//
// The shell test (DevAdminRail.test.tsx) uses NuqsTestingAdapter, which fakes
// URL handling — it can never catch bugs in the nuqs ↔ TanStack Router
// interplay. This test renders the rail inside a real createRouter (browser
// history, like the desktop webview) wrapped in the REAL custom NuqsAdapter
// (src/lib/nuqs-tanstack-router-adapter), then drives the same click sequence
// a user does: open the rail, click a section header. The rail must stay open
// (?devRail survives the ?devSec write).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { NuqsAdapter } from '../../lib/nuqs-tanstack-router-adapter';

vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));

// Stub the lazy panels (their data layers are tested elsewhere).
vi.mock('./panels/FlagsPanel', () => ({ default: () => <div data-testid="panel-flags" /> }));
vi.mock('./panels/RunPanel', () => ({ default: () => <div data-testid="panel-run" /> }));
vi.mock('./panels/NotificationsPanel', () => ({ default: () => <div data-testid="panel-notifications" /> }));
vi.mock('./panels/ServiceHealthPanel', () => ({ default: () => <div data-testid="panel-health" /> }));
vi.mock('./panels/DeployStatePanel', () => ({ default: () => <div data-testid="panel-deploy" /> }));
vi.mock('./panels/DbHealthPanel', () => ({ default: () => <div data-testid="panel-db" /> }));
vi.mock('./panels/FleetPanel', () => ({ default: () => <div data-testid="panel-fleet" /> }));

import DevAdminRail from './DevAdminRail';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function makeRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <NuqsAdapter>
        <DevAdminRail />
        <Outlet />
      </NuqsAdapter>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="page" />,
  });
  return createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });
}

describe('DevAdminRail × real TanStack router + real nuqs adapter', () => {
  it('stays open when a section header is clicked (devRail survives the devSec write)', async () => {
    render(<RouterProvider router={makeRouter()} />);

    // Open the rail.
    const handle = await screen.findByTestId('dev-admin-rail-handle');
    fireEvent.click(handle);
    await waitFor(() =>
      expect(screen.getByTestId('dev-admin-rail').getAttribute('data-collapsed')).toBe('false'),
    );
    // The open state must actually land in the URL (not just optimistic state).
    await waitFor(() => expect(window.location.search).toContain('devRail=true'));

    // Click a section header — the bug: this closed the whole rail.
    fireEvent.click(screen.getByTestId('dev-rail-sec-fleet'));
    await waitFor(() => expect(window.location.search).toContain('devSec=fleet'));
    expect(window.location.search).toContain('devRail=true');
    expect(screen.getByTestId('dev-admin-rail').getAttribute('data-collapsed')).toBe('false');
    expect(await screen.findByTestId('panel-fleet')).toBeTruthy();

    // And a second section click keeps it open too.
    fireEvent.click(screen.getByTestId('dev-rail-sec-db'));
    await waitFor(() => expect(window.location.search).toContain('devSec=db'));
    expect(screen.getByTestId('dev-admin-rail').getAttribute('data-collapsed')).toBe('false');
  });
});
