// @vitest-environment jsdom
/**
 * open-dock-panel (owner ask 2026-07-19): the Overview Agents tile's `open`
 * must ensure the requested panel EXISTS in the Working-tab dock (the user's
 * persisted layout may not include it) and focus it — via a window queue the
 * dock drains on api-bind, surviving the Overview → Working mount gap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestDockPanelOpen, drainPanelOpens, OPEN_DOCK_PANEL_EVENT } from './open-dock-panel';

type QueueWindow = Window & { __PAPERCUSP_PENDING_PANEL_OPENS__?: Array<{ type: string; title?: string }> };

const qw = () => window as QueueWindow;

beforeEach(() => {
  qw().__PAPERCUSP_PENDING_PANEL_OPENS__ = [];
});

describe('requestDockPanelOpen', () => {
  it('queues the request and fires the drain event', () => {
    const fired = vi.fn();
    window.addEventListener(OPEN_DOCK_PANEL_EVENT, fired);
    requestDockPanelOpen('adv:agents');
    expect(qw().__PAPERCUSP_PENDING_PANEL_OPENS__).toEqual([{ type: 'adv:agents', title: undefined }]);
    expect(fired).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_DOCK_PANEL_EVENT, fired);
  });

  it('dedupes repeat clicks for the same type before the dock mounts', () => {
    requestDockPanelOpen('adv:agents');
    requestDockPanelOpen('adv:agents');
    expect(qw().__PAPERCUSP_PENDING_PANEL_OPENS__).toHaveLength(1);
  });
});

describe('drainPanelOpens', () => {
  const deps = (panels: Array<{ id: string; type: string; params: Record<string, unknown> }>) => ({
    slug: 'papercusp',
    listPanels: () => panels,
    openPanel: vi.fn(() => 'new-id'),
    focusPanel: vi.fn(),
  });

  it('focuses an existing panel of the requested type (never duplicates it)', () => {
    qw().__PAPERCUSP_PENDING_PANEL_OPENS__ = [{ type: 'adv:agents' }];
    const d = deps([{ id: 'p1', type: 'adv:agents', params: {} }]);
    drainPanelOpens(d);
    expect(d.openPanel).not.toHaveBeenCalled();
    expect(d.focusPanel).toHaveBeenCalledWith('p1');
    expect(qw().__PAPERCUSP_PENDING_PANEL_OPENS__).toEqual([]);
  });

  it('opens + focuses the panel when absent, threading the harness slug', () => {
    qw().__PAPERCUSP_PENDING_PANEL_OPENS__ = [{ type: 'adv:agents' }];
    const d = deps([{ id: 'w1', type: 'adv:work-items', params: {} }]);
    drainPanelOpens(d);
    expect(d.openPanel).toHaveBeenCalledWith({
      type: 'adv:agents',
      title: undefined,
      params: { harnessSlug: 'papercusp' },
    });
    expect(d.focusPanel).toHaveBeenCalledWith('new-id');
    expect(qw().__PAPERCUSP_PENDING_PANEL_OPENS__).toEqual([]);
  });

  it('leaves the entry QUEUED when the dock api is not bound yet (open throws) — the bind handler retries', () => {
    qw().__PAPERCUSP_PENDING_PANEL_OPENS__ = [{ type: 'adv:agents' }];
    const d = {
      slug: 'papercusp',
      listPanels: () => {
        throw new Error('dock api not bound');
      },
      openPanel: vi.fn(),
      focusPanel: vi.fn(),
    };
    drainPanelOpens(d);
    expect(qw().__PAPERCUSP_PENDING_PANEL_OPENS__).toHaveLength(1);
  });
});
