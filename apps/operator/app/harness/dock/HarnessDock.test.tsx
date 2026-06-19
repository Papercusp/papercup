// @vitest-environment jsdom
/**
 * HarnessDock.test.tsx — render-branch coverage for the /harness/* root dock.
 *
 * HarnessDock's own logic worth covering in jsdom is its error-state branch
 * (a failed layout load → an inline error card with Retry + Reset-to-default
 * actions) versus the happy path (renders <DockviewReact>). The dockview
 * runtime, the layout-fetching `useDockLayout` hook, and the side-effect
 * shortcut/plugin hooks are all mocked to controllable stand-ins so the
 * assertions land on HarnessDock's branching + its button handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// dockview: DockviewReact → a stub that records the className it was given and
// the component-map keys, without booting the real grid (canvas/DOM heavy).
vi.mock('dockview', () => ({
  DockviewReact: ({ className }: { className?: string }) => (
    <div data-testid="dockview" data-classname={className} />
  ),
}));
vi.mock('dockview-react/dist/styles/dockview.css', () => ({}));
vi.mock('./dock-drawer-guard.css', () => ({}));

// useDockLayout drives the branch under test — control its `state` per test.
const reset = vi.fn(async () => {});
const refresh = vi.fn(async () => {});
const save = vi.fn(async () => {});
let dockState: { status: string; row: unknown; error: { message: string } | null };
vi.mock('./useDockLayout', () => ({
  useDockLayout: () => ({ state: dockState, save, reset, refresh }),
}));

// Side-effect hooks → no-ops (their own behavior is tested elsewhere).
vi.mock('./useNavShortcuts', () => ({ useNavShortcuts: () => {} }));
vi.mock('./useLayoutResetShortcut', () => ({ useLayoutResetShortcut: () => {} }));
vi.mock('./useRegisterPluginPanels', () => ({ useRegisterPluginPanels: () => {} }));
vi.mock('./useFocusedPanelTracker', () => ({ useFocusedPanelTracker: () => {} }));
vi.mock('./dock-actions', () => ({ bindDockApi: vi.fn() }));
vi.mock('./iframe-host', () => ({ destroy: vi.fn() }));
// panel-registry: a minimal subscribe/list so useComponentsForLayout runs.
vi.mock('./panel-registry', () => ({
  panelRegistry: { subscribe: () => () => {}, list: () => [], get: () => undefined },
}));
vi.mock('./MissingPanel', () => ({ MissingPanel: () => null }));
// Layout adapter + well-formed guard: treat the ready row as well-formed.
vi.mock('./layout-adapter', () => ({
  toDockviewJson: (d: unknown) => d,
  toLayoutDoc: (d: unknown) => d,
}));
vi.mock('@papercusp/operator-core/lib/dock-layouts', () => ({
  isWellFormedLayout: (d: unknown) => d != null,
}));

import { HarnessDock } from './HarnessDock';

beforeEach(() => {
  dockState = { status: 'loading', row: null, error: null };
  reset.mockClear();
  refresh.mockClear();
});
afterEach(cleanup);

describe('HarnessDock (dockview root)', () => {
  it('renders the dockview surface while loading', () => {
    dockState = { status: 'loading', row: null, error: null };
    render(<HarnessDock layoutName="default" />);
    expect(screen.getByTestId('dockview')).toBeTruthy();
  });

  it('applies the provided className to the dockview root', () => {
    render(<HarnessDock layoutName="default" className="my-theme" />);
    expect(screen.getByTestId('dockview').getAttribute('data-classname')).toBe('my-theme');
  });

  it('falls back to the default dockview theme when no className is given', () => {
    render(<HarnessDock layoutName="default" />);
    expect(screen.getByTestId('dockview').getAttribute('data-classname')).toBe('dockview-theme-dark');
  });

  it('renders the error card (with the layout name + message) when the layout fails to load', () => {
    dockState = { status: 'error', row: null, error: new Error('boom') };
    render(<HarnessDock layoutName="dashboard:sheets" />);
    expect(screen.getByText(/Failed to load layout/i)).toBeTruthy();
    expect(screen.getByText('dashboard:sheets')).toBeTruthy();
    expect(screen.getByText(/boom/i)).toBeTruthy();
    // The dockview surface is NOT rendered in the error branch.
    expect(screen.queryByTestId('dockview')).toBeNull();
  });

  it('Retry calls refresh()', () => {
    dockState = { status: 'error', row: null, error: new Error('boom') };
    render(<HarnessDock layoutName="default" />);
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it('Reset to default calls reset()', () => {
    dockState = { status: 'error', row: null, error: new Error('boom') };
    render(<HarnessDock layoutName="default" />);
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }));
    expect(reset).toHaveBeenCalled();
  });

  it('renders the dockview surface on a ready well-formed layout', () => {
    dockState = {
      status: 'ready',
      row: { schemaVersion: 1, updatedTs: 1, layoutJson: { root: { kind: 'tabs', panels: [] } } },
      error: null,
    };
    render(<HarnessDock layoutName="default" />);
    expect(screen.getByTestId('dockview')).toBeTruthy();
    expect(screen.queryByText(/Failed to load layout/i)).toBeNull();
  });
});
