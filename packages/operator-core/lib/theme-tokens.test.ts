import { describe, expect, it } from 'vitest';
import {
  customThemeCss,
  CustomThemeValidationError,
  isCustomThemeId,
  isSafeCssValue,
  isValidThemeId,
  slugifyThemeId,
  validateCustomTheme,
} from './theme-tokens';

describe('theme id helpers', () => {
  it('accepts built-ins and custom:<slug>, rejects junk', () => {
    expect(isValidThemeId('frost')).toBe(true);
    expect(isValidThemeId('black')).toBe(true);
    expect(isValidThemeId('hive')).toBe(false);
    expect(isValidThemeId('custom:my-theme')).toBe(true);
    expect(isCustomThemeId('custom:my-theme')).toBe(true);
    expect(isValidThemeId('custom:')).toBe(false);
    expect(isValidThemeId('rainbow')).toBe(false);
    expect(isValidThemeId(42)).toBe(false);
    expect(isValidThemeId(null)).toBe(false);
  });

  it('slugifies labels safely', () => {
    expect(slugifyThemeId('My Cool Theme!')).toBe('my-cool-theme');
    expect(slugifyThemeId('   ')).toBe('theme');
    expect(slugifyThemeId('Über/Dark 2')).toBe('ber-dark-2');
  });
});

describe('isSafeCssValue', () => {
  it('accepts common color value shapes', () => {
    for (const v of ['#000', '#0a0a0a', 'rgba(255, 255, 255, 0.14)', 'hsl(210 50% 10%)', 'white', 'var(--sky-400)', 'oklch(0.6 0.1 250 / 0.5)']) {
      expect(isSafeCssValue(v), v).toBe(true);
    }
  });

  it('rejects CSS-injection attempts and oversized/empty values', () => {
    for (const v of [
      '#000; } body { display:none',
      'red} html{background:url(http://evil)}',
      'url(http://x)',
      '<script>',
      'expression(alert(1))',
      'javascript:alert(1)',
      '',
      'x'.repeat(201),
    ]) {
      expect(isSafeCssValue(v), v).toBe(false);
    }
    expect(isSafeCssValue(42)).toBe(false);
  });
});

describe('validateCustomTheme', () => {
  const valid = { label: 'Midnight', tokens: { bg: '#000000', accent: '#88aaff' } };

  it('normalizes a valid theme (slug from label, trimmed values)', () => {
    const t = validateCustomTheme({ ...valid, tokens: { bg: '  #000000  ', fg: '#fff' } });
    expect(t.id).toBe('midnight');
    expect(t.label).toBe('Midnight');
    expect(t.tokens.bg).toBe('#000000');
    expect(t.tokens.fg).toBe('#fff');
  });

  it('keeps a provided id (slugified)', () => {
    expect(validateCustomTheme({ id: 'My ID', ...valid }).id).toBe('my-id');
  });

  it('THEME CONTRACT — rejects non-semantic token keys', () => {
    expect(() => validateCustomTheme({ label: 'X', tokens: { 'sky-400': '#000' } })).toThrow(
      CustomThemeValidationError,
    );
    expect(() => validateCustomTheme({ label: 'X', tokens: { nonsense: '#000' } })).toThrow(
      CustomThemeValidationError,
    );
  });

  it('rejects unsafe values, empty token maps, and bad labels', () => {
    expect(() => validateCustomTheme({ label: 'X', tokens: { bg: 'red;}html{x:1' } })).toThrow(
      CustomThemeValidationError,
    );
    expect(() => validateCustomTheme({ label: 'X', tokens: {} })).toThrow(CustomThemeValidationError);
    expect(() => validateCustomTheme({ label: '', tokens: { bg: '#000' } })).toThrow(CustomThemeValidationError);
    expect(() => validateCustomTheme(null)).toThrow(CustomThemeValidationError);
  });
});

describe('customThemeCss', () => {
  it('emits a scoped [data-theme="custom:<id>"] block', () => {
    const css = customThemeCss({ id: 'mid', label: 'Mid', tokens: { bg: '#000', accent: '#88f' } });
    expect(css).toContain('[data-theme="custom:mid"]');
    expect(css).toContain('--bg: #000;');
    expect(css).toContain('--accent: #88f;');
  });
});
