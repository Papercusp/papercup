/**
 * Coverage for crossOriginUrl — the loopback sibling-host sharding helper that
 * keeps on-demand fetches off the SSE-saturated origin (localhost <-> 127.0.0.1).
 * Runs in the node env (no jsdom): window is undefined by default, and we
 * stub a window.location to exercise the rewrite branches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossOriginUrl } from './cross-origin-url';

function stubLocation(loc: { protocol: string; hostname: string; port: string }) {
  vi.stubGlobal('window', { location: loc });
}

afterEach(() => vi.unstubAllGlobals());

describe('crossOriginUrl', () => {
  it('is SSR-safe — returns the path unchanged when window is absent', () => {
    expect(crossOriginUrl('/api/x')).toBe('/api/x');
  });

  it('rewrites localhost → 127.0.0.1 keeping scheme + port', () => {
    stubLocation({ protocol: 'http:', hostname: 'localhost', port: '3070' });
    expect(crossOriginUrl('/api/harness/p/git/show/abc')).toBe(
      'http://127.0.0.1:3070/api/harness/p/git/show/abc',
    );
  });

  it('rewrites 127.0.0.1 → localhost', () => {
    stubLocation({ protocol: 'https:', hostname: '127.0.0.1', port: '3055' });
    expect(crossOriginUrl('/p')).toBe('https://localhost:3055/p');
  });

  it('omits the colon when there is no port', () => {
    stubLocation({ protocol: 'http:', hostname: 'localhost', port: '' });
    expect(crossOriginUrl('/p')).toBe('http://127.0.0.1/p');
  });

  it('leaves the path unchanged on a non-loopback host (nothing to shard)', () => {
    stubLocation({ protocol: 'https:', hostname: 'app.example.com', port: '443' });
    expect(crossOriginUrl('/p')).toBe('/p');
  });

  it('no-ops inside the Tauri webview even on http://localhost (same-origin /api rides IPC)', () => {
    // The dev desktop shell loads the webview on http://localhost:3070 — which
    // passes the http guard with a loopback hostname and WOULD shard to the
    // 127.0.0.1 sibling. But the webview's /api fetch rides the desktop-ipc
    // polyfill, and the cross-origin loopback fetch is rejected by WebKitGTK
    // ("Load failed", broke commit-diff). The __TAURI_INTERNALS__ guard no-ops.
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: 'localhost', port: '3070' },
      __TAURI_INTERNALS__: { invoke: () => {} },
    });
    expect(crossOriginUrl('/api/harness/p/git/show/abc')).toBe('/api/harness/p/git/show/abc');
  });

  it('no-ops under the desktop papercusp:// custom scheme (same-origin /api rides the IPC polyfill)', () => {
    // Linux/macOS desktop origin is papercusp://localhost. hostname IS
    // "localhost", so without the http(s) guard this would wrongly shard to
    // papercusp://127.0.0.1 — escaping the desktop-ipc polyfill + failing CORS.
    stubLocation({ protocol: 'papercusp:', hostname: 'localhost', port: '' });
    expect(crossOriginUrl('/api/agent-mcp/saved-prompts')).toBe('/api/agent-mcp/saved-prompts');
  });

  it('no-ops under the Windows http://papercusp.localhost custom-scheme mapping', () => {
    // Windows maps the scheme onto http://papercusp.localhost; protocol passes
    // the http guard but the hostname isn't a loopback sibling, so still no-op.
    stubLocation({ protocol: 'http:', hostname: 'papercusp.localhost', port: '' });
    expect(crossOriginUrl('/api/x')).toBe('/api/x');
  });
});
