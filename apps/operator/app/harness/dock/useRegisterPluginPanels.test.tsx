/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRegisterPluginPanels } from './useRegisterPluginPanels';
import { panelRegistry } from './panel-registry';

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
