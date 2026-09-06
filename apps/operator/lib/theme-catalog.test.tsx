// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  data: undefined as unknown,
  loading: true,
  fetching: true,
  error: null as unknown,
  invalidate: vi.fn(),
  writeProfile: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: h.data,
    loading: h.loading,
    fetching: h.fetching,
    error: h.error,
    invalidate: h.invalidate,
  }),
}));
vi.mock('@papercusp/operator-core/lib/profile-pref', () => ({
  injectedPref: () => null,
  reconcileProfilePref: vi.fn(async () => null),
  writeProfileField: (...args: unknown[]) => h.writeProfile(...args),
}));

import {
  CUSTOM_THEMES_CATALOG_KEY,
  CUSTOM_THEMES_CSS_KEY,
  THEME_STORAGE_KEY,
  readCachedThemeCatalog,
  useThemeCatalog,
  type CustomTheme,
} from './theme';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

const cachedTheme: CustomTheme = {
  id: 'installed:abc',
  label: 'Aurora',
  tokens: { bg: '#101820', accent: '#ff8c42' },
  installed: true,
  packageRef: 'acme-themes-aurora',
  listingRef: 'aurora',
  version: '1.0.0',
  source: 'https://github.com/acme/themes',
};

const storageRows = new Map<string, string>();
const localStorageStub: Storage = {
  get length() { return storageRows.size; },
  clear: () => storageRows.clear(),
  getItem: (key) => storageRows.get(key) ?? null,
  key: (index) => [...storageRows.keys()][index] ?? null,
  removeItem: (key) => { storageRows.delete(key); },
  setItem: (key, value) => { storageRows.set(key, String(value)); },
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageStub });

beforeEach(() => {
  window.__PAPERCUSP_WS__ = 'alpha';
  window.localStorage.clear();
  document.getElementById('pc-custom-themes')?.remove();
  h.data = undefined;
  h.loading = true;
  h.fetching = true;
  h.error = null;
  h.invalidate.mockClear();
  h.writeProfile.mockClear();
});

afterEach(cleanup);

describe('useThemeCatalog recovery', () => {
  it('keeps the last known-good workspace catalog and CSS during a transient read miss', () => {
    window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY), JSON.stringify([cachedTheme]));
    window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CSS_KEY), 'cached-css-sentinel');
    h.error = new Error('offline');

    const { result } = renderHook(() => useThemeCatalog());

    expect(result.current.themes).toEqual([cachedTheme]);
    expect(window.localStorage.getItem(wsLocalKey(CUSTOM_THEMES_CSS_KEY))).toBe('cached-css-sentinel');
  });

  it('caches and applies a live catalog, then recovers from a prior miss', async () => {
    const { result, rerender } = renderHook(() => useThemeCatalog());
    expect(result.current.themes).toEqual([]);

    h.data = [cachedTheme];
    h.loading = false;
    h.fetching = false;
    rerender();

    await waitFor(() => expect(result.current.themes).toEqual([cachedTheme]));
    expect(readCachedThemeCatalog()).toEqual([cachedTheme]);
    expect(document.getElementById('pc-custom-themes')?.textContent).toContain('[data-theme="custom:installed:abc"]');
  });

  it('isolates fallback catalogs by workspace id', () => {
    window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY), JSON.stringify([cachedTheme]));
    expect(readCachedThemeCatalog()).toEqual([cachedTheme]);

    window.__PAPERCUSP_WS__ = 'beta';
    expect(readCachedThemeCatalog()).toEqual([]);
  });

  it('falls back through the canonical writer when a live catalog removes the active theme', async () => {
    window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), 'custom:gone');
    h.data = [];
    h.loading = false;
    h.fetching = false;

    renderHook(() => useThemeCatalog());

    await waitFor(() => expect(h.writeProfile).toHaveBeenCalledWith('theme_id', 'frost'));
    expect(window.localStorage.getItem(wsLocalKey(THEME_STORAGE_KEY))).toBe('frost');
  });

  it('does not erase an injected custom selection while the initial catalog is still loading', async () => {
    window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), 'custom:installed:abc');
    window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY), JSON.stringify([cachedTheme]));
    h.data = [];
    h.loading = true;
    h.fetching = true;

    const { result, rerender } = renderHook(() => useThemeCatalog());

    expect(result.current.themes).toEqual([cachedTheme]);
    expect(h.writeProfile).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(wsLocalKey(THEME_STORAGE_KEY))).toBe('custom:installed:abc');

    h.data = [cachedTheme];
    h.loading = false;
    h.fetching = false;
    rerender();

    await waitFor(() => expect(result.current.themes).toEqual([cachedTheme]));
    expect(h.writeProfile).not.toHaveBeenCalled();
  });

  it('treats corrupt cached metadata as absent without throwing', () => {
    window.localStorage.setItem(wsLocalKey(CUSTOM_THEMES_CATALOG_KEY), '{bad json');
    expect(readCachedThemeCatalog()).toEqual([]);
  });
});
