/**
 * Unit tests for dock-actions binding & dispatch.
 *
 * Mocks the DockviewApi shape since dockview's real API requires a
 * mounted DOM. We test the binding + delegation contract; live HMR
 * smoke + integration verifies the real wiring.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  bindDockApi,
  onDockApiBind,
  openPanel,
  focusPanel,
  closePanel,
  setPanelParams,
  setPanelTitle,
  listPanels,
  getFocusedPanel,
} from './dock-actions';
import { panelRegistry } from './panel-registry';

const Stub = () => null;

function makeFakeApi() {
  const panels: Array<{ id: string; api: any; params: any; group: any; title?: string }> = [];
  const fake = {
    addPanel: vi.fn((opts: { id: string; component: string; title?: string; params?: any; position?: any; floating?: any }) => {
      const panel = {
        id: opts.id,
        title: opts.title,
        params: opts.params,
        contentComponent: opts.component,
        group: null as any,
        api: {
          setActive: vi.fn(),
          updateParameters: vi.fn(),
          setTitle: vi.fn(),
          close: vi.fn(),
        },
      };
      panels.push(panel);
      // Attach group + activePanel
      panel.group = { activePanel: panel };
      return panel;
    }),
    getPanel: vi.fn((id: string) => panels.find((p) => p.id === id)),
    removePanel: vi.fn((panel: { id: string }) => {
      const idx = panels.findIndex((p) => p.id === panel.id);
      if (idx >= 0) panels.splice(idx, 1);
    }),
    panels,
    activeGroup: null as any,
    toJSON: vi.fn(() => ({
      grid: { root: { type: 'leaf', data: { views: panels.map((p) => p.id), id: 'r' } }, height: 0, width: 0, orientation: 'HORIZONTAL' },
      panels: Object.fromEntries(panels.map((p) => [p.id, { id: p.id, contentComponent: p.contentComponent, title: p.title, params: p.params }])),
    })),
  };
  // Auto-update activeGroup when panels exist.
  Object.defineProperty(fake, 'activeGroup', {
    get() {
      return panels.length > 0 ? { activePanel: panels[panels.length - 1] } : null;
    },
  });
  return fake as any;
}

beforeEach(() => {
  bindDockApi(null);
  panelRegistry._reset();
});

describe('dock-actions binding', () => {
  it('throws when no api bound', () => {
    expect(() => listPanels()).toThrow(/dock not mounted/);
  });

  it('bindDockApi + onDockApiBind notifies subscribers', () => {
    const fake = makeFakeApi();
    const listener = vi.fn();
    const unsub = onDockApiBind(listener);
    expect(listener).toHaveBeenCalledTimes(0);
    bindDockApi(fake);
    expect(listener).toHaveBeenCalledWith(fake);
    bindDockApi(null);
    expect(listener).toHaveBeenLastCalledWith(null);
    unsub();
    bindDockApi(fake);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('onDockApiBind fires immediately if already bound', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const listener = vi.fn();
    onDockApiBind(listener);
    expect(listener).toHaveBeenCalledWith(fake);
  });
});

describe('dock-actions actions', () => {
  it('openPanel auto-generates id when omitted', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ type: 'data:features', params: { slug: 's' } });
    expect(id).toMatch(/^p-/);
    expect(fake.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id, component: 'data:features', params: { slug: 's' } }),
    );
  });

  it('openPanel honors explicit id and group', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ id: 'my-id', type: 'data:logs', group: 'main' });
    expect(id).toBe('my-id');
    expect(fake.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'my-id',
        position: { referenceGroup: 'main' },
      }),
    );
  });

  it('openPanel as floating sets floating opts with defaults', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    openPanel({ type: 'view:vscode', floating: { width: 600 } });
    expect(fake.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        floating: { x: 80, y: 80, width: 600, height: 360 },
      }),
    );
  });

  it('focusPanel returns false when panel not found', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    expect(focusPanel('nope')).toBe(false);
  });

  it('focusPanel calls setActive on the panel', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ type: 'data:features' });
    expect(focusPanel(id)).toBe(true);
    const panel = fake.getPanel(id);
    expect(panel.api.setActive).toHaveBeenCalledTimes(1);
  });

  it('closePanel removes from dockview', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ type: 'data:features' });
    expect(closePanel(id)).toBe(true);
    expect(fake.removePanel).toHaveBeenCalled();
    expect(closePanel(id)).toBe(false);
  });

  it('setPanelParams + setPanelTitle delegate to panel api', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ type: 'data:features' });
    setPanelParams(id, { foo: 1 });
    setPanelTitle(id, 'New');
    const panel = fake.getPanel(id);
    expect(panel.api.updateParameters).toHaveBeenCalledWith({ foo: 1 });
    expect(panel.api.setTitle).toHaveBeenCalledWith('New');
  });

  it('listPanels returns snapshots with isActive flag', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    openPanel({ type: 'data:features', id: 'a' });
    const id2 = openPanel({ type: 'data:issues', id: 'b' });
    const list = listPanels();
    expect(list.length).toBe(2);
    // Last-opened is the activeGroup's activePanel in our fake
    expect(list.find((p) => p.id === id2)?.isActive).toBe(true);
  });

  it('getFocusedPanel returns activeGroup.activePanel data', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    const id = openPanel({ type: 'data:features', params: { x: 1 } });
    const focused = getFocusedPanel();
    expect(focused?.id).toBe(id);
    expect(focused?.type).toBe('data:features');
    expect(focused?.params).toEqual({ x: 1 });
  });

  it('getFocusedPanel returns null when no panels open', () => {
    const fake = makeFakeApi();
    bindDockApi(fake);
    expect(getFocusedPanel()).toBeNull();
  });

  it('openPanel passes renderer:always when registry meta keepAlive=true', () => {
    panelRegistry.register('keep:me', Stub, { keepAlive: true });
    const fake = makeFakeApi();
    bindDockApi(fake);
    openPanel({ type: 'keep:me' });
    expect(fake.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ renderer: 'always' }),
    );
  });

  it('openPanel omits renderer when keepAlive is not set', () => {
    panelRegistry.register('drop:me', Stub, {});
    const fake = makeFakeApi();
    bindDockApi(fake);
    openPanel({ type: 'drop:me' });
    const call = fake.addPanel.mock.calls[0][0] as { renderer?: string };
    expect(call.renderer).toBeUndefined();
  });

  it('panelType reads from view.contentComponent (real dockview shape)', () => {
    const fake = makeFakeApi();
    // Swap the fake panel to use the dockview-real shape: `view.contentComponent`
    // instead of top-level `contentComponent`. listPanels must still resolve.
    bindDockApi({
      ...fake,
      panels: [
        {
          id: 'p1',
          title: 't',
          params: {},
          view: { contentComponent: 'data:features' },
          group: { activePanel: { id: 'p1' } },
        },
      ],
    } as unknown as Parameters<typeof bindDockApi>[0]);
    const list = listPanels();
    expect(list[0].type).toBe('data:features');
  });
});
