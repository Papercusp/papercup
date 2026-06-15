// @vitest-environment jsdom
/**
 * FrameVncView.test — the live VNC leg of the Swarm view
 * (hive-frame-desktops-live-view-2026-06-06 P-009, D-002).
 *
 * Render-smoke + the connect/error/teardown state machine. The noVNC RFB
 * client and the mint-session fetch are mocked: a fake RFB records the wsUrl,
 * viewOnly flag, and registered listeners so we can fire connect/disconnect and
 * assert the state + onState callback. fetch is stubbed per-test for the
 * happy / refused / network-error branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

// A controllable fake RFB behind the @novnc/novnc default-import mock (hoisted:
// the mock factory references it).
const h = vi.hoisted(() => {
  const instances: Array<{
    el: unknown;
    url: string;
    viewOnly: boolean;
    scaleViewport: boolean;
    background: string;
    listeners: Record<string, () => void>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeRFB {
    el: unknown;
    url: string;
    viewOnly = false;
    scaleViewport = false;
    background = '';
    listeners: Record<string, () => void> = {};
    disconnect = vi.fn();
    constructor(el: unknown, url: string) {
      this.el = el;
      this.url = url;
      instances.push(this);
    }
    addEventListener(type: string, cb: () => void) {
      this.listeners[type] = cb;
    }
  }
  return { instances, FakeRFB };
});

vi.mock('@novnc/novnc', () => ({ default: h.FakeRFB }));

import FrameVncView from './FrameVncView';

beforeEach(() => {
  h.instances.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Render + flush the async session-mint + dynamic RFB import. */
async function renderView(props: Partial<Parameters<typeof FrameVncView>[0]> = {}) {
  const onState = vi.fn();
  const r = render(<FrameVncView slug="frame-1" display={2} drive={false} onState={onState} {...props} />);
  // Two microtask flushes: fetch().then(json) then the dynamic import().
  await act(async () => {});
  await act(async () => {});
  return { ...r, onState };
}

describe('<FrameVncView>', () => {
  it('mints a watch session and connects a view-only RFB to the returned wsUrl', async () => {
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://127.0.0.1/vnc' }) }));
    await renderView({ drive: false });

    // The mint POST carried the watch mode + display.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/deploy/frame-1/vnc-session');
    expect(JSON.parse(String(init.body))).toEqual({ display: 2, mode: 'watch' });

    expect(h.instances).toHaveLength(1);
    const rfb = h.instances[0];
    expect(rfb.url).toBe('ws://127.0.0.1/vnc');
    expect(rfb.viewOnly).toBe(true); // watch ⇒ view-only client-side too
    expect(rfb.scaleViewport).toBe(true);
  });

  it('drive=true mints a takeover session and the RFB is NOT view-only', async () => {
    const fetchMock = stubFetch(() => ({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://x/vnc' }) }));
    await renderView({ drive: true });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).mode).toBe('takeover');
    expect(h.instances[0].viewOnly).toBe(false);
  });

  it('shows the connecting overlay until the RFB fires connect, then clears it', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://x/vnc' }) }));
    const { container, onState } = await renderView();
    expect(screen.getByText(/Connecting to the frame/)).toBeTruthy();
    expect(container.querySelector('.pc-frame-vnc')!.getAttribute('data-state')).toBe('connecting');

    act(() => h.instances[0].listeners.connect());
    expect(screen.queryByText(/Connecting to the frame/)).toBeNull();
    expect(container.querySelector('.pc-frame-vnc')!.getAttribute('data-state')).toBe('connected');
    expect(onState).toHaveBeenCalledWith('connected');
  });

  it('a disconnect after connect transitions to the ended overlay', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://x/vnc' }) }));
    const { onState } = await renderView();
    act(() => h.instances[0].listeners.connect());
    act(() => h.instances[0].listeners.disconnect());
    expect(screen.getByText(/Live session ended/)).toBeTruthy();
    expect(onState).toHaveBeenLastCalledWith('ended');
  });

  it('surfaces a refused mint (ok:false) as the error overlay and never builds an RFB', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ ok: false, error: 'no display' }) }));
    const { onState } = await renderView();
    expect(screen.getByText(/Live view failed: no display/)).toBeTruthy();
    expect(h.instances).toHaveLength(0);
    expect(onState).toHaveBeenLastCalledWith('error');
  });

  it('surfaces an HTTP failure with a synthesised message', async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await renderView();
    expect(screen.getByText(/Live view failed: HTTP 503/)).toBeTruthy();
  });

  it('disconnects the RFB on unmount (viewer-left tears down the frame x11vnc)', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://x/vnc' }) }));
    const { unmount } = await renderView();
    const rfb = h.instances[0];
    unmount();
    expect(rfb.disconnect).toHaveBeenCalled();
  });
});
