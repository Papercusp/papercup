import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installedThemeId,
  installedThemeRef,
  listInstalledThemes,
  readThemeDir,
  writeThemePackageDir,
} from './theme-store';

function packageDir(
  root: string,
  ref: string,
  overrides: Record<string, unknown> = {},
  listingOverrides: Record<string, unknown> = {},
): string {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'theme.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'aurora',
      label: 'Aurora',
      description: 'A cool light theme',
      version: '1.2.0',
      baseTheme: 'portal-light',
      colorScheme: 'light',
      tokens: { bg: '#f7fbff', fg: '#102030', accent: 'oklch(0.62 0.18 250)' },
      ...overrides,
    }),
  );
  writeFileSync(
    join(dir, 'listing.json'),
    JSON.stringify({
      kind: 'theme',
      ref: 'aurora',
      title: 'Aurora',
      version: '1.2.0',
      source: 'https://github.com/acme/themes',
      ...listingOverrides,
    }),
  );
  return dir;
}

describe('installed theme package store', () => {
  it('parses a versioned light theme and assigns a source-qualified local id', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-theme-store-'));
    try {
      const dir = packageDir(root, 'acme-aurora');
      expect(readThemeDir(dir, 'acme-aurora')).toMatchObject({
        id: installedThemeId('package:acme-aurora', 'aurora'),
        label: 'Aurora',
        installed: true,
        packageRef: 'acme-aurora',
        listingRef: 'aurora',
        baseTheme: 'portal-light',
        colorScheme: 'light',
        version: '1.2.0',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults a missing base to frost/dark for backward-compatible packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-theme-store-'));
    try {
      const dir = packageDir(root, 'legacy', { baseTheme: undefined, colorScheme: undefined });
      expect(readThemeDir(dir, 'legacy')).toMatchObject({ baseTheme: 'frost', colorScheme: 'dark' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects wrong-kind, unsupported, unsafe and non-semantic-reference packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-theme-store-'));
    try {
      expect(readThemeDir(packageDir(root, 'wrong', {}, { kind: 'recipe' }), 'wrong')).toBeNull();
      expect(readThemeDir(packageDir(root, 'future', { schemaVersion: 2 }), 'future')).toBeNull();
      expect(readThemeDir(packageDir(root, 'base', { baseTheme: 'unknown' }), 'base')).toBeNull();
      expect(readThemeDir(packageDir(root, 'unsafe', { tokens: { bg: 'red; } html {' } }), 'unsafe')).toBeNull();
      expect(readThemeDir(packageDir(root, 'primitive', { tokens: { bg: 'var(--sky-400)' } }), 'primitive')).toBeNull();
      expect(readThemeDir(packageDir(root, 'token', { tokens: { 'sky-400': '#38bdf8' } }), 'token')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enumerates only valid packages and keeps same-label publishers distinct', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-theme-store-'));
    try {
      packageDir(root, 'one', {}, { source: 'https://github.com/alice/themes' });
      packageDir(root, 'two', {}, { source: 'https://github.com/bob/themes' });
      packageDir(root, 'bad', { version: ' spaces are invalid ' });
      const themes = listInstalledThemes([{ dir: root, layer: 'user' }]);
      expect(themes).toHaveLength(2);
      expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
      expect(themes.map((theme) => theme.label)).toEqual(['Aurora', 'Aurora']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives a deterministic safe directory ref from repo plus listing ref', () => {
    const a = installedThemeRef('https://github.com/acme/theme-library.git', 'aurora');
    expect(a).toMatch(/^[a-z0-9-]+-[0-9a-f]{12}$/);
    expect(installedThemeRef('https://github.com/acme/theme-library.git', 'aurora')).toBe(a);
    expect(installedThemeRef('https://github.com/other/theme-library.git', 'aurora')).not.toBe(a);
  });

  it('exports a local theme without placing it in the installed layer', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-theme-export-'));
    try {
      const written = writeThemePackageDir(
        { id: 'local-aurora', label: 'Local Aurora', tokens: { bg: '#ffffff', fg: '#111111' } },
        { targetDir: root, source: 'https://github.com/acme/themes', version: '2.0.0', baseTheme: 'portal-light' },
      );
      expect(written.ref).toBe('local-aurora');
      expect(readThemeDir(written.dir, 'export-test')).toMatchObject({
        label: 'Local Aurora', version: '2.0.0', baseTheme: 'portal-light', colorScheme: 'light',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
