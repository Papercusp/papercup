/**
 * Coverage for theme's pure selector helpers: themeList (built-ins followed by
 * custom themes mapped to custom:<id> ThemeMeta) and findCustomTheme (resolve an
 * active custom:<slug> id back to its definition). The DOM/fetch paths
 * (applyCustomThemes, fetch/save/delete) are out of scope here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  themeList,
  findCustomTheme,
  readActiveTheme,
  BUILTIN_THEMES,
  CUSTOM_PREFIX,
  DEFAULT_THEME_ID,
  type CustomTheme,
} from './theme';

const custom = (id: string, label = id): CustomTheme => ({ id, label }) as unknown as CustomTheme;

describe('themeList', () => {
  it('returns just the built-ins when there are no custom themes', () => {
    expect(themeList([])).toEqual([...BUILTIN_THEMES]);
  });

  it('appends custom themes as custom:<id> ThemeMeta (builtin:false)', () => {
    const list = themeList([custom('sunset', 'Sunset')]);
    expect(list).toHaveLength(BUILTIN_THEMES.length + 1);
    expect(list[list.length - 1]).toEqual({
      id: `${CUSTOM_PREFIX}sunset`,
      label: 'Sunset',
      builtin: false,
    });
  });
});

describe('findCustomTheme', () => {
  const themes = [custom('sunset'), custom('forest')];

  it('resolves a custom:<slug> active id to its definition', () => {
    expect(findCustomTheme(`${CUSTOM_PREFIX}forest`, themes)).toBe(themes[1]);
  });

  it('returns null for a built-in (non-custom) active id', () => {
    expect(findCustomTheme(BUILTIN_THEMES[0].id, themes)).toBeNull();
  });

  it('returns null when the custom slug is not found', () => {
    expect(findCustomTheme(`${CUSTOM_PREFIX}missing`, themes)).toBeNull();
  });
});

describe('readActiveTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers a valid cached value', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'black' },
      location: { href: 'http://127.0.0.1:3070/' },
    });
    expect(readActiveTheme()).toBe('black');
  });

  it('falls back to the host-injected PG value when the cache is cold (the reload-persistence fix)', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null },
      __PAPERCUSP_PREFS__: { theme_id: 'black' },
      location: { href: 'http://127.0.0.1:3070/' },
    });
    expect(readActiveTheme()).toBe('black');
  });

  it('defaults to frost when neither cache nor injection is valid', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null },
      location: { href: 'http://127.0.0.1:3070/' },
    });
    expect(readActiveTheme()).toBe(DEFAULT_THEME_ID);
  });
});

describe('installed theme base application', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets the generated base layer and color scheme from cached package metadata', () => {
    const html = { dataset: {} as Record<string, string>, style: { colorScheme: '', removeProperty: vi.fn() } };
    vi.stubGlobal('document', { documentElement: html });
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => key.includes('customThemesMeta')
        ? JSON.stringify({ 'custom:installed:abc': { baseTheme: 'portal-light', colorScheme: 'light' } })
        : null },
      location: { href: 'http://127.0.0.1:3070/' },
    });
    applyTheme('custom:installed:abc');
    expect(html.dataset).toMatchObject({ theme: 'custom:installed:abc', themeBase: 'portal-light' });
    expect(html.style.colorScheme).toBe('light');
  });
});
