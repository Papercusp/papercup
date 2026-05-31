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
});
