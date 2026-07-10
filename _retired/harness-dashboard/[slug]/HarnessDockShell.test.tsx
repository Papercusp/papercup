// @vitest-environment jsdom
/**
 * HarnessDockShell.test.tsx — render coverage for the Phase-5 dock shell
 * (/harness/<slug>?dock=1). The shell is mostly an effect-only mount around
 * <HarnessDock>, but it owns a header (Dock label, slug, the "← Classic"
 * exit affordance) with a router.push handler worth covering. The heavy dock
 * children (HarnessDock, the catalog/menu/onboarding/chevrons) and the
 * dock-actions wiring are stubbed so the assertions land on the shell's own
 * header + the Classic-exit handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const push = vi.fn();
vi.mock('@/lib/router-compat/navigation', () => ({ useRouter: () => ({ push }) }));

// Stub the heavy dock children to tiny markers so we can assert they mount
// with the slug-derived props without booting dockview.
vi.mock('../dock/HarnessDock', () => ({
  HarnessDock: ({ layoutName, slug }: { layoutName: string; slug: string }) => (
    <div data-testid="harness-dock" data-layout={layoutName} data-slug={slug} />
  ),
}));
vi.mock('../dock/sample-panels', () => ({ registerSamplePanels: vi.fn() }));
vi.mock('../dock/AddPanelCatalog', () => ({
  AddPanelCatalog: ({ defaultSlug }: { defaultSlug: string }) => (
    <div data-testid="add-panel" data-slug={defaultSlug} />
  ),
}));
vi.mock('../dock/DockNavChevrons', () => ({ DockNavChevrons: () => <div data-testid="chevrons" /> }));
vi.mock('../dock/DockOnboarding', () => ({ DockOnboarding: () => <div data-testid="onboarding" /> }));
vi.mock('../dock/LayoutsMenu', () => ({
  LayoutsMenu: ({ currentLayoutName }: { currentLayoutName: string }) => (
    <div data-testid="layouts-menu" data-layout={currentLayoutName} />
  ),
}));
// onDockApiBind returns an unbind fn; bind callback can be a no-op (we never
// fire an api here). Returning the binder lets the shell's effect run cleanly.
vi.mock('../dock/dock-actions', () => ({
  openPanel: vi.fn(),
  listPanels: vi.fn(() => []),
  setPanelParams: vi.fn(),
  onDockApiBind: vi.fn(() => () => {}),
}));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import HarnessDockShell from './HarnessDockShell';

beforeEach(() => {
  push.mockClear();
});
afterEach(cleanup);

describe('HarnessDockShell (/harness/<slug>?dock=1)', () => {
  it('renders the header (Dock label + slug) and the dock children wired to the slug', () => {
    render(<HarnessDockShell slug="sheets" />);
    expect(screen.getByText('Dock')).toBeTruthy();
    expect(screen.getByText('sheets')).toBeTruthy();
    // The root dock is mounted with the dashboard:<slug> layout name.
    const dock = screen.getByTestId('harness-dock');
    expect(dock.getAttribute('data-layout')).toBe('dashboard:sheets');
    expect(dock.getAttribute('data-slug')).toBe('sheets');
  });

  it('threads the slug into the AddPanelCatalog + LayoutsMenu', () => {
    render(<HarnessDockShell slug="forms" />);
    expect(screen.getByTestId('add-panel').getAttribute('data-slug')).toBe('forms');
    expect(screen.getByTestId('layouts-menu').getAttribute('data-layout')).toBe('dashboard:forms');
  });

  it('mounts the onboarding + nav chevrons affordances', () => {
    render(<HarnessDockShell slug="sheets" />);
    expect(screen.getByTestId('onboarding')).toBeTruthy();
    expect(screen.getByTestId('chevrons')).toBeTruthy();
  });

  it('the "← Classic" button routes back to the classic dashboard', () => {
    render(<HarnessDockShell slug="sheets" />);
    fireEvent.click(screen.getByRole('button', { name: /Classic/i }));
    expect(push).toHaveBeenCalledWith('/harness/sheets');
  });
});
