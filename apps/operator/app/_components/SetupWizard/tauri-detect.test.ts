// @vitest-environment node
/**
 * tauri-detect.ts — `isTauri()` decides whether the SetupWizard runs inside
 * the Tauri desktop shell (the only supported run surface) vs a bare browser.
 *
 * Detection keys off two globals Tauri injects into the webview —
 * `window.__TAURI_INTERNALS__` (v2) and `window.__TAURI__` (legacy) — and
 * is guarded for SSR where `window` is undefined.
 *
 * The node test env has no `window` (verified: typeof window === 'undefined'),
 * so the bare call covers the SSR guard; the desktop cases stub a fake window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTauri } from './tauri-detect';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isTauri', () => {
  it('returns false under SSR (window undefined)', () => {
    expect(typeof window).toBe('undefined');
    expect(isTauri()).toBe(false);
  });

  it('returns false in a plain browser window (neither global present)', () => {
    vi.stubGlobal('window', {});
    expect(isTauri()).toBe(false);
  });

  it('returns true when __TAURI_INTERNALS__ is present (v2 shell)', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: () => {} } });
    expect(isTauri()).toBe(true);
  });

  it('returns true when the legacy __TAURI__ global is present', () => {
    vi.stubGlobal('window', { __TAURI__: {} });
    expect(isTauri()).toBe(true);
  });

  it('returns true when both globals are present', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __TAURI__: {} });
    expect(isTauri()).toBe(true);
  });

  it('treats a falsy global value as not-present', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: undefined, __TAURI__: null });
    expect(isTauri()).toBe(false);
  });
});
