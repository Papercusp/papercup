/**
 * Coverage for browser-workspace: getBrowserWorkspaceId id-source precedence
 * (injected __PAPERCUSP_WS__ → ?ws= → 'default') + wsLocalKey namespacing.
 * window is stubbed; the no-window (SSR) path runs in the bare node env.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserWorkspaceId, wsLocalKey } from './browser-workspace';

afterEach(() => vi.unstubAllGlobals());

describe('getBrowserWorkspaceId', () => {
  it("returns 'default' when there is no window (SSR)", () => {
    expect(getBrowserWorkspaceId()).toBe('default');
  });

  it('prefers the injected __PAPERCUSP_WS__ global', () => {
    vi.stubGlobal('window', {
      __PAPERCUSP_WS__: 'ws-injected',
      location: { href: 'http://127.0.0.1:3070/?ws=ws-query' },
    });
    expect(getBrowserWorkspaceId()).toBe('ws-injected'); // injected wins over ?ws=
  });

  it('falls back to the ?ws= query param', () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:3070/x?ws=ws-query' } });
    expect(getBrowserWorkspaceId()).toBe('ws-query');
  });

  it("falls back to 'default' when neither is present", () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:3070/' } });
    expect(getBrowserWorkspaceId()).toBe('default');
  });

  it('ignores a blank injected value', () => {
    vi.stubGlobal('window', { __PAPERCUSP_WS__: '   ', location: { href: 'http://127.0.0.1:3070/?ws=ws-q' } });
    expect(getBrowserWorkspaceId()).toBe('ws-q');
  });
});

describe('wsLocalKey', () => {
  it('namespaces a key under the active workspace', () => {
    vi.stubGlobal('window', { __PAPERCUSP_WS__: 'ws-9', location: { href: 'http://127.0.0.1:3070/' } });
    expect(wsLocalKey('autoScan')).toBe('pc:ws:ws-9:autoScan');
  });

  it("uses 'default' under SSR", () => {
    expect(wsLocalKey('k')).toBe('pc:ws:default:k');
  });
});
