// @vitest-environment jsdom
/**
 * LeftSidebar shell coverage (left-sidebar-tauri-2026-06-07) — the docked,
 * collapsible Colony rail. Mirrors the DevAdminRail shell test: the 5 lazy tab
 * panels are stubbed so this covers the SHELL — the collapsed icon rail vs the
 * expanded shell, open/collapse + tab switching writing ?lsb/?lst atomically (one
 * setRail), the OVERWATCH flag gating its tab (and snapping a stale ?lst=overwatch
 * back to Queen), Queen as the default tab, the body-reservation side effect, and
 * the chromeless-route null-out. nuqs runs via the real testing adapter so the
 * atomic useQueryStates write is exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({ overwatchOn: false, pathname: '/adv' }));

vi.mock('@papercusp/flags/client', () => ({ useFlag: () => H.overwatchOn }));
vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => H.pathname }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));
// Stub the lazy tab panels with trivial markers — their own surfaces are tested
// separately (QueenTab / OverwatchTab / SwarmTab / VoiceTab / HivesTab).
vi.mock('./AccountsTab', () => ({ default: () => <div data-testid="panel-accounts" /> }));
vi.mock('./QueenTab', () => ({ default: () => <div data-testid="panel-queen" /> }));
vi.mock('./OverwatchTab', () => ({ default: () => <div data-testid="panel-overwatch" /> }));
vi.mock('./SwarmTab', () => ({ default: () => <div data-testid="panel-swarm" /> }));
vi.mock('./VoiceTab', () => ({ default: () => <div data-testid="panel-voice" /> }));
vi.mock('./HivesTab', () => ({ default: () => <div data-testid="panel-hives" /> }));

import LeftSidebar from './LeftSidebar';

beforeEach(() => {
  H.overwatchOn = false;
  H.pathname = '/adv';
  document.body.className = '';
});
afterEach(() => {
  cleanup();
  document.body.className = '';
});

function renderRail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<LeftSidebar />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

describe('<LeftSidebar> shell', () => {
  it('defaults to OPEN on the Queen tab (the owner-default Colony tab)', async () => {
    renderRail();
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rail.getAttribute('data-tab')).toBe('queen');
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  it('orders Accounts as the leftmost tab before Queen', () => {
    renderRail();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((x) => x.textContent?.trim()).slice(0, 2)).toEqual(['Accounts', 'Queen']);
  });

  it('deep-links a tab from ?lst= and mounts only that panel', async () => {
    renderRail('?lst=hives');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('hives');
    expect(await screen.findByTestId('panel-hives')).toBeTruthy();
    expect(screen.queryByTestId('panel-queen')).toBeNull();
  });

  it('collapses to the icon rail on ?lsb=false and unmounts the active panel', () => {
    renderRail('?lsb=false');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByTestId('panel-queen')).toBeNull();
    // The collapsed expand-rail icon buttons are present.
    expect(screen.getByTestId('left-sidebar-rail-swarm')).toBeTruthy();
  });

  it('clicking a tab switches the active panel and writes ?lst', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByTestId('left-sidebar-tab-swarm'));
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('swarm'));
    expect(await screen.findByTestId('panel-swarm')).toBeTruthy();
    expect(lastQuery()).toContain('lst=swarm');
  });

  it('the collapse button writes ?lsb=false', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    await waitFor(() => expect(lastQuery()).toContain('lsb=false'));
  });

  it('a collapsed icon-rail button expands AND selects its tab atomically (one write)', async () => {
    // ?lsb default is `true`, so the URL omits lsb=true once re-opened; assert the
    // observable rail state instead — both the expand (collapsed=false) AND the tab
    // selection (data-tab=voice) must land from the single setRail write.
    renderRail('?lsb=false');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('left-sidebar-rail-voice'));
    await waitFor(() => {
      const rail = screen.getByTestId('left-sidebar');
      expect(rail.getAttribute('data-collapsed')).toBe('false');
      expect(rail.getAttribute('data-tab')).toBe('voice');
    });
    expect(await screen.findByTestId('panel-voice')).toBeTruthy();
  });

  it('hides the Overwatch tab while the OVERWATCH flag is off', () => {
    H.overwatchOn = false;
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
    // Other tabs are present.
    expect(screen.getByTestId('left-sidebar-tab-queen')).toBeTruthy();
  });

  it('shows the Overwatch tab when the flag is on', () => {
    H.overwatchOn = true;
    renderRail();
    expect(screen.getByTestId('left-sidebar-tab-overwatch')).toBeTruthy();
  });

  it('snaps a stale ?lst=overwatch back to Queen while the flag is off', async () => {
    H.overwatchOn = false;
    renderRail('?lst=overwatch');
    // The guard effect rewrites lst → queen (the default, so it's omitted from the
    // URL); assert the rail lands on the Queen tab + panel.
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen'));
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  it('renders nothing on a chromeless (iframe-target) route', () => {
    H.pathname = '/pi/some-embed';
    const { container } = render(
      <NuqsTestingAdapter>
        <LeftSidebar />
      </NuqsTestingAdapter>,
    );
    expect(container.querySelector('[data-testid="left-sidebar"]')).toBeNull();
  });

  it('reserves left-side layout space (body.has-left-sidebar) when docked', async () => {
    renderRail();
    await waitFor(() => expect(document.body.classList.contains('has-left-sidebar')).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--left-sidebar-w')).toBeTruthy();
  });
});
