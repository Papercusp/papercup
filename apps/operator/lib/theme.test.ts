/**
 * Coverage for theme's pure selector helpers: themeList (built-ins followed by
 * custom themes mapped to custom:<id> ThemeMeta) and findCustomTheme (resolve an
 * active custom:<slug> id back to its definition). The DOM/fetch paths
 * (applyCustomThemes, fetch/save/delete) are out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { themeList, findCustomTheme, BUILTIN_THEMES, CUSTOM_PREFIX, type CustomTheme } from './theme';

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
