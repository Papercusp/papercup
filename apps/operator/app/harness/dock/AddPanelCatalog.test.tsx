/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the routed
// catalog labels from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
import { AddPanelCatalog } from './AddPanelCatalog';
import { panelRegistry } from './panel-registry';
import { bindDockApi } from './dock-actions';

const Stub = () => null;

function makeFakeApi() {
  return {
    addPanel: vi.fn((opts: { id: string; component: string }) => {
      const panel = {
        id: opts.id,
        component: opts.component,
        api: { setActive: vi.fn() },
      };
      return panel;
    }),
    getPanel: vi.fn((id: string) => ({
      id,
      api: { setActive: vi.fn() },
    })),
    removePanel: vi.fn(),
    panels: [],
    activeGroup: null,
    toJSON: vi.fn(() => ({
      grid: { root: { type: 'leaf', data: { views: [], id: 'r' } }, height: 0, width: 0, orientation: 'HORIZONTAL' },
      panels: {},
    })),
  } as unknown as Parameters<typeof bindDockApi>[0];
}

beforeEach(() => {
  panelRegistry._reset();
  bindDockApi(null);
});
afterEach(() => cleanup());

describe('AddPanelCatalog', () => {
  it('shows the trigger button', () => {
    render(<AddPanelCatalog />);
    expect(screen.getByLabelText('Add panel')).toBeTruthy();
  });

  it('opens the popover on click', () => {
    render(<AddPanelCatalog />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Open panel')).toBeTruthy();
  });

  it('lists registered panel types in the popover', () => {
    panelRegistry.register('data:features', Stub);
    panelRegistry.register('data:issues', Stub);
    render(<AddPanelCatalog />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.getByText('Features')).toBeTruthy();
    expect(screen.getByText('Issues')).toBeTruthy();
  });

  it('excludes stub panel types by default', () => {
    panelRegistry.register('view:design', Stub);
    panelRegistry.register('data:features', Stub);
    render(<AddPanelCatalog />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    // 'Features' is real, 'Design' is a stub — only Features should show.
    expect(screen.getByText('Features')).toBeTruthy();
    expect(screen.queryByText('Design')).toBeNull();
  });

  it('includeStubs=true shows stub types', () => {
    panelRegistry.register('view:design', Stub);
    panelRegistry.register('data:features', Stub);
    render(<AddPanelCatalog includeStubs />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.getByText('Design')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
  });

  it('shows empty state when no panels registered', () => {
    render(<AddPanelCatalog />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.getByText('No panel types registered.')).toBeTruthy();
  });

  it('clicking a panel type calls dock-actions.openPanel + closes', () => {
    panelRegistry.register('data:features', Stub);
    const fakeApi = makeFakeApi();
    bindDockApi(fakeApi);
    render(<AddPanelCatalog defaultSlug="sheets" />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    fireEvent.click(screen.getByText('Features'));
    expect((fakeApi as unknown as { addPanel: { mock: { calls: unknown[][] } } }).addPanel).toHaveBeenCalled();
    const opts = (fakeApi as unknown as { addPanel: { mock: { calls: Array<[Record<string, unknown>]> } } }).addPanel.mock.calls[0][0];
    expect(opts.component).toBe('data:features');
    expect((opts.params as Record<string, unknown>).harnessSlug).toBe('sheets');
    // popover closes after selection
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // WI-125: 'adv:chat' is a multi-instance slot type — a BUSY slot (bound to a
  // chatId) must not block opening another; only a FREE slot re-focuses.
  it('a BUSY chat slot does not block opening another chat panel', () => {
    panelRegistry.register('adv:chat', Stub, { title: 'Chat' });
    const fakeApi = makeFakeApi();
    (fakeApi as unknown as { panels: unknown[] }).panels = [
      {
        id: 'chat-busy',
        component: 'adv:chat',
        title: 'worker · WI-1',
        params: { harnessSlug: 'sheets', chatId: 'c-1' },
        group: null,
        api: { setActive: vi.fn() },
      },
    ];
    bindDockApi(fakeApi);
    render(<AddPanelCatalog defaultSlug="sheets" />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    // busy slot → not marked "already open"
    expect(screen.queryByLabelText('already open')).toBeNull();
    fireEvent.click(screen.getByText('Chat'));
    // a NEW panel opens instead of stealing focus to the busy chat
    expect((fakeApi as unknown as { addPanel: { mock: { calls: unknown[][] } } }).addPanel).toHaveBeenCalled();
  });

  it('a FREE chat slot is focused instead of duplicated', () => {
    panelRegistry.register('adv:chat', Stub, { title: 'Chat' });
    const fakeApi = makeFakeApi();
    const setActive = vi.fn();
    (fakeApi as unknown as { panels: unknown[] }).panels = [
      {
        id: 'chat-free',
        component: 'adv:chat',
        title: 'Chat',
        params: { harnessSlug: 'sheets' },
        group: null,
        api: { setActive },
      },
    ];
    (fakeApi as unknown as { getPanel: unknown }).getPanel = vi.fn((id: string) => ({ id, api: { setActive } }));
    bindDockApi(fakeApi);
    render(<AddPanelCatalog defaultSlug="sheets" />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.getByLabelText('already open')).toBeTruthy();
    fireEvent.click(screen.getByText('Chat'));
    expect(setActive).toHaveBeenCalled();
    expect((fakeApi as unknown as { addPanel: { mock: { calls: unknown[][] } } }).addPanel).not.toHaveBeenCalled();
  });

  it('re-renders when registry changes (plugin late-register)', async () => {
    render(<AddPanelCatalog />);
    fireEvent.click(screen.getByLabelText('Add panel'));
    expect(screen.queryByText('Features')).toBeNull();
    // Late register inside act so the subscriber-driven setState flushes.
    await act(async () => {
      panelRegistry.register('data:features', Stub);
    });
    await waitFor(() => expect(screen.getByText('Features')).toBeTruthy());
  });
});
