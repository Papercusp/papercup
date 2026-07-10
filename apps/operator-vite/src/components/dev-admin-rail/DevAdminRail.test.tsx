// @vitest-environment jsdom
//
// Dev admin rail shell — P-001 (collapsible, nuqs-backed open + active-section)
// and P-009 (open/section state round-trips via the URL). The rail is DOCKED
// (like the op-chat sidebar): the aside is always mounted, collapsing to a thin
// expand-rail rather than disappearing. The 7 lazily-imported section panels are
// stubbed so this test covers the SHELL: the collapsed expand-rail, open/close,
// the single-open accordion, that the accordion is unmounted while collapsed, and
// that every interaction writes the nuqs URL params (?devRail / ?devSec). Panel
// data behavior is tested separately at the resolver level (dev-glances.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// The rail reads the route (to skip iframe-target/chromeless routes) and a
// workspace-scoped localStorage key for its width. Stub both so the shell test
// needs no router context and stays isolated from operator-core.
vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => '/adv' }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));

// Stub the 7 lazy panels with trivial markers so we don't pull in FeaturesAdmin /
// AdminOps / useSyncQuery (their own surfaces are tested elsewhere).
vi.mock('./panels/FlagsPanel', () => ({ default: () => <div data-testid="panel-flags" /> }));
vi.mock('./panels/RunPanel', () => ({ default: () => <div data-testid="panel-run" /> }));
vi.mock('./panels/NotificationsPanel', () => ({ default: () => <div data-testid="panel-notifications" /> }));
vi.mock('./panels/ServiceHealthPanel', () => ({ default: () => <div data-testid="panel-health" /> }));
vi.mock('./panels/DeployStatePanel', () => ({ default: () => <div data-testid="panel-deploy" /> }));
vi.mock('./panels/DbHealthPanel', () => ({ default: () => <div data-testid="panel-db" /> }));
vi.mock('./panels/FleetPanel', () => ({ default: () => <div data-testid="panel-fleet" /> }));

import DevAdminRail from './DevAdminRail';

afterEach(cleanup);

// Isolation guard. The packaged-install suite run (2026-07-09) failed the
// deep-link test below with TWO <aside data-testid="dev-admin-rail"> nodes in
// one document: a container from an earlier test outlived afterEach(cleanup)
// (`retry` is 0, so it was not a retried attempt). A leaked rail carries its
// own still-mounted NuqsTestingAdapter, and two adapters racing over `devSec`
// drive the fresh rail back to its default section — so the deep-linked panel
// never mounts and the failure reads as a missing `panel-deploy` instead of as
// the leak it is. It has not reproduced in 22 runs (both machines, single-file
// and full-workspace, CI=1, one fork, saturated CPU, shuffled order), so rather
// than paper over the symptom with a longer findBy timeout, assert the
// precondition: if the leak recurs it fails HERE, named.
beforeEach(() => {
  expect(
    document.querySelectorAll('[data-testid="dev-admin-rail"]'),
    'a previous test leaked a mounted rail — the DOM is not isolated',
  ).toHaveLength(0);
});

function renderRail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<DevAdminRail />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  // Latest query string nuqs wrote, or '' if nothing written yet.
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

describe('DevAdminRail shell', () => {
  it('is docked-but-collapsed by default: the rail mounts, the expand-rail shows, and the accordion is unmounted', () => {
    renderRail();
    const rail = screen.getByTestId('dev-admin-rail');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('dev-admin-rail-handle')).toBeTruthy();
    // Accordion (and its panels) are not rendered while collapsed.
    expect(screen.queryByTestId('dev-rail-sec-flags')).toBeNull();
  });

  it('clicking the expand-rail opens it — writes ?devRail=true to the URL', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByTestId('dev-admin-rail-handle'));
    // nuqs throttles URL writes — await the flush.
    await waitFor(() => expect(lastQuery()).toContain('devRail=true'));
  });

  it('when open (?devRail=true) it shows the rail expanded with all 7 section headers, flags active by default', async () => {
    renderRail('?devRail=true');
    const rail = screen.getByTestId('dev-admin-rail');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    for (const sec of ['flags', 'run', 'notifications', 'health', 'deploy', 'db', 'fleet']) {
      expect(screen.getByTestId(`dev-rail-sec-${sec}`)).toBeTruthy();
    }
    // Default active section = flags → only its panel body is mounted (lazy).
    expect(await screen.findByTestId('panel-flags')).toBeTruthy();
    expect(screen.queryByTestId('panel-deploy')).toBeNull();
  });

  it('deep-links the active section: ?devRail=true&devSec=deploy mounts the deploy panel', async () => {
    renderRail('?devRail=true&devSec=deploy');
    expect(await screen.findByTestId('panel-deploy')).toBeTruthy();
    expect(screen.queryByTestId('panel-flags')).toBeNull();
  });

  it('clicking a section header switches the active section — writes ?devSec to the URL', async () => {
    const { lastQuery } = renderRail('?devRail=true');
    await screen.findByTestId('panel-flags');
    fireEvent.click(screen.getByTestId('dev-rail-sec-fleet'));
    await waitFor(() => expect(lastQuery()).toContain('devSec=fleet'));
    expect(await screen.findByTestId('panel-fleet')).toBeTruthy();
    // Single-open accordion: the previously-active flags panel unmounts.
    await waitFor(() => expect(screen.queryByTestId('panel-flags')).toBeNull());
  });

  it('clicking close collapses the rail — clears devRail and re-shows the expand-rail', async () => {
    renderRail('?devRail=true');
    fireEvent.click(screen.getByLabelText('Close dev admin rail'));
    // setOpen(false) === the parseAsBoolean default → the rail collapses back to
    // the expand-rail (and nuqs drops the now-default param); the accordion unmounts.
    await waitFor(() =>
      expect(screen.getByTestId('dev-admin-rail').getAttribute('data-collapsed')).toBe('true'),
    );
    expect(screen.getByTestId('dev-admin-rail-handle')).toBeTruthy();
    expect(screen.queryByTestId('dev-rail-sec-flags')).toBeNull();
  });
});
