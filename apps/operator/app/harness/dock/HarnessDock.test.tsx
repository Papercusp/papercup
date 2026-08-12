// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

type DockWorkspaceProps = {
  layoutName: string;
  store: unknown;
  className?: string;
  missingComponent?: unknown;
  canClosePanel?: unknown;
  onApiReady?: (api: unknown) => void;
  onApiDispose?: () => void;
  onPanelRemoved?: (panelId: string) => void;
  resetEventName?: string;
  loadEventName?: string;
};

const dockWorkbenchMock = vi.hoisted(() => ({
  props: [] as DockWorkspaceProps[],
  store: { kind: 'fetch-store' },
  createFetchDockLayoutStore: vi.fn(() => ({ kind: 'fetch-store' })),
}));

const appMocks = vi.hoisted(() => ({
  bindDockApi: vi.fn(),
  canClosePanel: vi.fn(() => true),
  configureCloseGuard: vi.fn(),
  destroyIframe: vi.fn(),
  useFocusedPanelTracker: vi.fn(),
  useLayoutResetShortcut: vi.fn(),
  useNavShortcuts: vi.fn(),
  useRegisterPluginPanels: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@papercusp/dock-workbench', async () => {
  const React = await import('react');
  return {
    createFetchDockLayoutStore: dockWorkbenchMock.createFetchDockLayoutStore,
    DockWorkspace: (props: DockWorkspaceProps) => {
      dockWorkbenchMock.props.push(props);
      return React.createElement('div', {
        'data-testid': 'dockview',
        'data-classname': props.className,
        'data-layout-name': props.layoutName,
      });
    },
  };
});

vi.mock('./dock-drawer-guard.css', () => ({}));
vi.mock('./MissingPanel', () => ({ MissingPanel: () => null }));
vi.mock('./dock-actions', () => ({ bindDockApi: appMocks.bindDockApi }));
vi.mock('./iframe-host', () => ({ destroy: appMocks.destroyIframe }));
vi.mock('./close-guard', () => ({
  canClosePanel: appMocks.canClosePanel,
  configureCloseGuard: appMocks.configureCloseGuard,
}));
vi.mock('./useFocusedPanelTracker', () => ({ useFocusedPanelTracker: appMocks.useFocusedPanelTracker }));
vi.mock('./useLayoutResetShortcut', () => ({ useLayoutResetShortcut: appMocks.useLayoutResetShortcut }));
vi.mock('./useNavShortcuts', () => ({ useNavShortcuts: appMocks.useNavShortcuts }));
vi.mock('./useRegisterPluginPanels', () => ({ useRegisterPluginPanels: appMocks.useRegisterPluginPanels }));
vi.mock('../useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: appMocks.confirm, element: null }),
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'default' }));
vi.mock('@papercusp/sync', () => ({ onSyncBusEvent: () => () => {}, fetchSyncQuery: vi.fn(async () => []) }));

// P-006 perf-marks wiring: spy begin/end, keep the real PERF_INTERACTIONS names.
const perfMarks = vi.hoisted(() => ({ begin: vi.fn(), end: vi.fn() }));
vi.mock('@/app/_components/perf/perf-marks', async (orig) => ({
  ...(await orig<typeof import('@/app/_components/perf/perf-marks')>()),
  beginInteraction: perfMarks.begin,
  endInteraction: perfMarks.end,
}));

import { HarnessDock } from './HarnessDock';

function lastDockProps() {
  const props = dockWorkbenchMock.props.at(-1);
  if (!props) throw new Error('DockWorkspace was not rendered');
  return props;
}

beforeEach(() => {
  dockWorkbenchMock.props.length = 0;
  dockWorkbenchMock.createFetchDockLayoutStore.mockClear();
  appMocks.bindDockApi.mockClear();
  appMocks.canClosePanel.mockClear();
  appMocks.configureCloseGuard.mockClear();
  appMocks.destroyIframe.mockClear();
  appMocks.useFocusedPanelTracker.mockClear();
  appMocks.useLayoutResetShortcut.mockClear();
  appMocks.useNavShortcuts.mockClear();
  appMocks.useRegisterPluginPanels.mockClear();
  appMocks.confirm.mockClear();
  perfMarks.begin.mockClear();
  perfMarks.end.mockClear();
});

afterEach(cleanup);

describe('HarnessDock (shared DockWorkspace adapter)', () => {
  it('renders the shared dock workspace with Papercusp defaults', () => {
    render(<HarnessDock layoutName="default" />);

    expect(screen.getByTestId('dockview').getAttribute('data-classname')).toBe('dockview-theme-dark');
    expect(lastDockProps()).toMatchObject({
      layoutName: 'default',
      resetEventName: 'papercusp:dock-reset-layout',
      loadEventName: 'papercusp:dock-load-layout',
    });
    expect(lastDockProps().store).toMatchObject({ kind: 'fetch-store', load: expect.any(Function) });
    expect(lastDockProps().canClosePanel).toBe(appMocks.canClosePanel);
  });

  it('passes a custom className through to the shared dock workspace', () => {
    render(<HarnessDock layoutName="default" className="my-theme" />);

    expect(screen.getByTestId('dockview').getAttribute('data-classname')).toBe('my-theme');
  });

  it('keeps Papercusp-specific side-effect hooks wired', () => {
    render(<HarnessDock layoutName="default" slug="demo-plugin" />);

    expect(appMocks.configureCloseGuard).toHaveBeenCalledWith({ confirm: expect.any(Function) });
    expect(appMocks.useNavShortcuts).toHaveBeenCalled();
    expect(appMocks.useLayoutResetShortcut).toHaveBeenCalledWith(expect.any(Function));
    expect(appMocks.useRegisterPluginPanels).toHaveBeenCalledWith('demo-plugin');
    expect(appMocks.useFocusedPanelTracker).toHaveBeenCalled();
  });

  it('dispatches the Papercusp reset event from the reset shortcut callback', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<HarnessDock layoutName="default" />);

    const resetCallback = appMocks.useLayoutResetShortcut.mock.calls.at(-1)?.[0];
    resetCallback();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'papercusp:dock-reset-layout' }));
    dispatch.mockRestore();
  });

  it('binds and clears the global dock API around DockWorkspace lifecycle', () => {
    const api = { id: 'dock-api' };
    render(<HarnessDock layoutName="default" />);

    lastDockProps().onApiReady?.(api);
    expect(appMocks.bindDockApi).toHaveBeenCalledWith(api);

    lastDockProps().onApiDispose?.();
    expect(appMocks.bindDockApi).toHaveBeenCalledWith(null);
  });

  it('emits the harness-dock-open perf interaction across mount → api-ready (P-006)', () => {
    render(<HarnessDock layoutName="default" />);
    // begins on mount; the measure is still open until the dock hydrates.
    expect(perfMarks.begin).toHaveBeenCalledWith('harness-dock-open');
    expect(perfMarks.end).not.toHaveBeenCalled();
    // ends when DockWorkspace binds the API (layout hydrated).
    lastDockProps().onApiReady?.({ id: 'dock-api' });
    expect(perfMarks.end).toHaveBeenCalledWith('harness-dock-open');
  });

  it('destroys iframe-backed panels when the shared workspace removes a panel', () => {
    render(<HarnessDock layoutName="default" />);

    lastDockProps().onPanelRemoved?.('panel-123');
    expect(appMocks.destroyIframe).toHaveBeenCalledWith('panel-123');
  });
});
