/** Stale-chunk auto-heal (2026-07-01): the pure decision — reload once for a
 *  chunk-load-shaped error, never loop, never reload for real render bugs. */
import { describe, it, expect } from 'vitest';
import { CHUNK_LOAD_ERROR_RE, shouldAutoReloadForChunkError } from './RouteErrorBoundary';

describe('shouldAutoReloadForChunkError', () => {
  const NOW = 1_000_000_000;

  it('reloads for every engine phrasing of a stale-chunk failure', () => {
    for (const msg of [
      'Importing a module script failed.', // WebKit (the Tauri webview)
      'Failed to fetch dynamically imported module: http://x/chunk-abc.js', // Chromium
      'error loading dynamically imported module', // Firefox
    ]) {
      expect(CHUNK_LOAD_ERROR_RE.test(msg)).toBe(true);
      expect(shouldAutoReloadForChunkError(new Error(msg), NOW, 0)).toBe(true);
    }
  });

  it('NEVER reloads for an ordinary render bug', () => {
    expect(shouldAutoReloadForChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"), NOW, 0)).toBe(false);
  });

  it('debounces: a second chunk error within 60s falls to the manual fallback (no reload loop)', () => {
    const err = new Error('Importing a module script failed.');
    expect(shouldAutoReloadForChunkError(err, NOW, NOW - 30_000)).toBe(false);
    expect(shouldAutoReloadForChunkError(err, NOW, NOW - 61_000)).toBe(true);
  });

  it('tolerates non-Error throwables', () => {
    expect(shouldAutoReloadForChunkError('Importing a module script failed.', NOW, 0)).toBe(true);
    expect(shouldAutoReloadForChunkError(null, NOW, 0)).toBe(false);
  });
});
