/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { PLUGIN_IFRAME_SANDBOX, useRegisterPluginPanels } from './useRegisterPluginPanels';
import { panelRegistry } from './panel-registry';
import { IframePanel } from './IframePanel';
import { _resetForTests } from './iframe-host';

const originalFetch = globalThis.fetch;

function setupFetch(panels: Array<Record<string, unknown>>) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ panels }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch;
}

beforeEach(() => panelRegistry._reset());
afterEach(() => {
  globalThis.fetch = originalFetch;
  panelRegistry._reset();
});

describe('useRegisterPluginPanels', () => {
  it('no slug → no fetch + no registrations', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    renderHook(() => useRegisterPluginPanels(''));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('registers iframe-type plugin panels', async () => {
    setupFetch([
      {
        pluginName: '@x/foo',
        id: 'bar',
        fullType: 'plugin:@x/foo:bar',
        title: 'Foo Bar',
        type: 'iframe',
        src: '/embed/foo-bar',
        keepAlive: true,
      },
    ]);
    renderHook(() => useRegisterPluginPanels('sheets'));
    await waitFor(() => expect(panelRegistry.has('plugin:@x/foo:bar')).toBe(true));
    const entry = panelRegistry.get('plugin:@x/foo:bar');
    expect(entry?.meta.title).toBe('Foo Bar');
    expect(entry?.meta.keepAlive).toBe(true);
  });

  it('registers known React-type plugin panel via KNOWN_REACT_PANELS', async () => {
    setupFetch([
      {
        pluginName: '@papercupai/pi-coding',
        id: 'pi',
        fullType: 'plugin:@papercupai/pi-coding:pi',
        title: 'Pi',
        type: 'react',
        componentRoot: '@papercusp/papercusp-shared',
        componentId: 'PiTerminalsDock',
      },
    ]);
    renderHook(() => useRegisterPluginPanels('sheets'));
    await waitFor(() =>
      expect(panelRegistry.has('plugin:@papercupai/pi-coding:pi')).toBe(true),
    );
    // Should be registered (via dynamic loader); we don't actually mount it.
    const entry = panelRegistry.get('plugin:@papercupai/pi-coding:pi');
    expect(entry?.meta.title).toBe('Pi');
  });

  it('registers unknown React-type plugin panel with not-yet message', async () => {
    setupFetch([
      {
        pluginName: '@x/unknown',
        id: 'panel',
        fullType: 'plugin:@x/unknown:panel',
        title: 'Unknown',
        type: 'react',
        componentRoot: '@x/unknown',
        componentId: 'SomeComponent',
      },
    ]);
    renderHook(() => useRegisterPluginPanels('sheets'));
    await waitFor(() => expect(panelRegistry.has('plugin:@x/unknown:panel')).toBe(true));
    const entry = panelRegistry.get('plugin:@x/unknown:panel');
    expect(entry?.meta.title).toBe('Unknown');
    expect(entry?.meta.keepAlive).toBe(false);
  });

  it('handles fetch failure silently (no registrations)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    renderHook(() => useRegisterPluginPanels('sheets'));
    // Wait a tick for the promise chain to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(panelRegistry.list()).toEqual([]);
  });

  it('cancels registration if slug changes mid-fetch', async () => {
    let resolve!: (v: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ) as unknown as typeof fetch;
    const { rerender, unmount } = renderHook(({ slug }) => useRegisterPluginPanels(slug), {
      initialProps: { slug: 'sheets' },
    });
    rerender({ slug: '' });
    unmount();
    // Resolve the original fetch — its `cancelled` flag should be set.
    resolve(
      new Response(
        JSON.stringify({
          panels: [
            {
              pluginName: '@x/foo',
              id: 'bar',
              fullType: 'plugin:@x/foo:bar',
              title: 'Foo Bar',
              type: 'iframe',
              src: '/x',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(panelRegistry.has('plugin:@x/foo:bar')).toBe(false);
  });
});

/**
 * P-005 (security-boundary-remediation-and-usability-2026-09-04): plugin/preview
 * content must be isolated WITHOUT native grants.
 *
 * The defect these guard: Tauri scopes capabilities by WINDOW LABEL, not frame
 * origin, so `main` holds allow-pty-spawn / fs / process / allow-console-launch /
 * allow-endpoint-invoke for everything inside it. A plugin panel's `src` is
 * supplied by that plugin's own contributions manifest, and `getOrCreateIframe`
 * only sets the attribute `if (options.sandbox)` — so a plugin panel used to be
 * created with NO sandbox at all, and a same-origin one could reach
 * `window.__TAURI__` and the whole native grant set through it.
 *
 * Per D-001 these come in pairs: the hostile path must fail BEFORE the protected
 * effect, and the legitimate path must still succeed.
 */
describe('plugin iframe isolation (P-005)', () => {
  beforeEach(() => {
    panelRegistry._reset();
    _resetForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    panelRegistry._reset();
    _resetForTests();
  });

  /**
   * Read sandbox tokens off the ATTRIBUTE, not `iframe.sandbox`.
   * jsdom does not reflect the `sandbox` DOMTokenList (it is `undefined` there),
   * so `frame.sandbox.contains(...)` throws rather than returning false — which
   * would look like a failing guard instead of a broken probe.
   */
  const sandboxTokens = (frame: HTMLIFrameElement) =>
    (frame.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);

  /** The dock api every panel component is handed (shape per workbench-panels.test.tsx). */
  const panelApi = { setParams: () => {}, setTitle: () => {}, close: () => {} };

  /** Register one iframe plugin panel and render it; return its live DOM iframe. */
  async function renderPluginPanel(panelOver: Record<string, unknown> = {}, params = {}) {
    setupFetch([
      {
        pluginName: '@x/foo',
        id: 'bar',
        fullType: 'plugin:@x/foo:bar',
        title: 'Foo Bar',
        type: 'iframe',
        src: '/embed/foo-bar',
        ...panelOver,
      },
    ]);
    renderHook(() => useRegisterPluginPanels('sheets'));
    await waitFor(() => expect(panelRegistry.has('plugin:@x/foo:bar')).toBe(true));
    const Comp = panelRegistry.get('plugin:@x/foo:bar')!.component;
    const { container } = render(
      <Comp panelId="p1" panelType="plugin:@x/foo:bar" params={params} api={panelApi} />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    return container.querySelector('iframe')!;
  }

  it('HOSTILE: a plugin iframe is sandboxed WITHOUT allow-same-origin, so it cannot reach the IPC bridge', async () => {
    const frame = await renderPluginPanel();
    const sandbox = frame.getAttribute('sandbox');
    expect(sandbox).toBe(PLUGIN_IFRAME_SANDBOX);
    // The single load-bearing assertion: an opaque origin cannot touch the app
    // origin's DOM/storage or the origin-gated Tauri IPC bridge.
    expect(sandboxTokens(frame)).not.toContain('allow-same-origin');
  });

  it('HOSTILE: a plugin CANNOT widen its own sandbox back to allow-same-origin', async () => {
    // The escape we are containing: allow-scripts + allow-same-origin together
    // lets a frame delete its own sandbox attribute outright.
    const frame = await renderPluginPanel(
      { sandbox: 'allow-scripts allow-same-origin' },
      { sandbox: 'allow-scripts allow-same-origin' },
    );
    expect(sandboxTokens(frame)).not.toContain('allow-same-origin');
    expect(frame.getAttribute('sandbox')).toBe(PLUGIN_IFRAME_SANDBOX);
  });

  it('LEGITIMATE: the plugin panel still renders its declared src and stays scriptable', async () => {
    const frame = await renderPluginPanel();
    expect(frame.getAttribute('src')).toContain('/embed/foo-bar');
    // A panel that cannot run scripts is not a usable panel — isolation must
    // not degrade into disabling the feature family (D-001).
    expect(sandboxTokens(frame)).toContain('allow-scripts');
    expect(sandboxTokens(frame)).toContain('allow-forms');
  });

  it('CALIBRATION: a FIRST-PARTY IframePanel is untouched (no sandbox) — the test can tell the two paths apart', async () => {
    // code-server / Drizzle Studio / previews render through IframePanel
    // directly, not through plugin registration, and must keep working. If this
    // ever starts reporting a sandbox, the guard above has over-reached from
    // "isolate untrusted plugins" into "break first-party panels" — and without
    // this control, the two hostile assertions above would still pass.
    const { container } = render(
      <IframePanel
        panelId="first-party-1"
        panelType="workbench"
        params={{ src: 'http://127.0.0.1:9999/workbench' }}
        api={panelApi}
      />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBeNull();
  });
});
