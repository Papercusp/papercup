// @vitest-environment jsdom
/**
 * PhoneTab — the Phone rail pane (WI-1403107).
 *
 * The mistake worth pinning here is NOT a crash. It is a pane that reads as
 * "the phone works" when it does not, and a pane that reads a unit systemd has
 * never heard of as a service that is merely stopped. Both render as ordinary
 * status text, so only an assertion catches them.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const syncState: { rows: unknown; error: unknown; lastOpts: any } = {
  rows: undefined,
  error: null,
  lastOpts: null,
};

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: unknown) => {
    syncState.lastOpts = opts;
    return { data: syncState.rows, error: syncState.error };
  },
}));

// RailSection is a collapsible shell; render its children so the assertions
// below are about THIS pane rather than about the section chrome.
vi.mock('./RailSection', () => ({
  default: ({ title, children }: { title: string; children: unknown }) => (
    <div data-testid={`section-${title}`}>{children as never}</div>
  ),
}));

import PhoneTab, { unitStatusLabel } from './PhoneTab';

const UP = {
  id: 'papercusp-phone-livekit.service',
  unit: 'papercusp-phone-livekit.service',
  role: 'Media server',
  known: true,
  activeState: 'active',
  subState: 'running',
  up: true,
  unknownUnit: false,
};

beforeEach(() => {
  syncState.rows = undefined;
  syncState.error = null;
  syncState.lastOpts = null;
});

describe('unitStatusLabel', () => {
  it('reports a unit systemd never heard of as NOT INSTALLED, not as down', () => {
    // The regression this function exists for: systemd answers `inactive` for a
    // nonexistent unit, byte-identical to its answer for an installed-and-
    // stopped one. Reading activeState first renders a renamed or typo'd unit
    // as a service to go restart.
    expect(unitStatusLabel({ known: false, activeState: 'inactive', up: false })).toBe(
      'not installed',
    );
  });

  it('reports a genuinely stopped unit with systemd’s own word', () => {
    expect(unitStatusLabel({ known: true, activeState: 'failed', up: false })).toBe('failed');
  });

  it('reports a running unit as running', () => {
    expect(unitStatusLabel({ known: true, activeState: 'active', up: true })).toBe('running');
  });
});

describe('<PhoneTab>', () => {
  it('ALWAYS states the PSTN wall, even when every unit is up', () => {
    // The whole reason this pane is shaped the way it is. Two green units plus
    // a nav entry called "Phone" reads as a working telephone; there is no
    // carrier number (plan phone-app-2026-08-30 P-003, owner-gated), so the
    // wall must be visible in exactly the state where it is easiest to miss.
    syncState.rows = [UP, { ...UP, id: 'sip', unit: 'sip', role: 'SIP gateway' }];
    render(<PhoneTab />);
    expect(screen.getByTestId('phone-pstn-wall').textContent).toContain('not provisioned');
  });

  it('distinguishes "not answered yet" from "everything is down"', () => {
    // An empty result before the first push must not render as a dead plane.
    render(<PhoneTab />);
    expect(screen.getByTestId('phone-plane-pending')).toBeTruthy();
  });

  it('does not fetch for an inactive tab', () => {
    // LeftSidebar mounts panes for tabs nobody is looking at, and this pane's
    // resolver shells out to systemd.
    render(<PhoneTab active={false} />);
    expect(syncState.lastOpts.enabled).toBe(false);
  });

  it('surfaces a query error instead of rendering an empty, healthy-looking pane', () => {
    syncState.error = new Error('systemd unreachable');
    render(<PhoneTab />);
    expect(screen.getByText(/systemd unreachable/)).toBeTruthy();
  });
});
