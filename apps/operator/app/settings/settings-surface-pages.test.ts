/**
 * Pins `SETTINGS_SURFACE_PAGES` (the route-free settings sub-page table a
 * router-less host mounts) to the two places the filesystem already owns that
 * truth: the operator-vite route files under `routes/settings/**` and the
 * `settings/**​/page.tsx` modules those routes render. A settings page added
 * on either side without a row here fails this test by name, so the table
 * cannot drift silently (derived-truth ladder rung 2: pin what must stay
 * hand-written).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_SUBPATH,
  SETTINGS_SURFACE_PAGES,
  isSettingsSubPath,
  settingsSubPathFor,
} from './settings-surface-pages';

const SETTINGS_APP_DIR = __dirname;
const VITE_SETTINGS_ROUTES_DIR = join(__dirname, '../../../operator-vite/src/routes/settings');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `routes/settings/<a>/<b>.tsx` → `a/b`; `<a>/index.tsx` → `a`; tests excluded. */
function routeSubPaths(): string[] {
  return walk(VITE_SETTINGS_ROUTES_DIR)
    .map((f) => relative(VITE_SETTINGS_ROUTES_DIR, f))
    .filter((rel) => rel.endsWith('.tsx') && !rel.endsWith('.test.tsx'))
    .map((rel) => rel.replace(/\.tsx$/, '').replace(/(^|\/)index$/, ''))
    .filter((sub) => sub.length > 0)
    .sort();
}

/** Every `page.tsx` below `app/settings/`, as its sub-path. */
function pageSubPaths(): string[] {
  return walk(SETTINGS_APP_DIR)
    .map((f) => relative(SETTINGS_APP_DIR, f))
    .filter((rel) => rel.endsWith('/page.tsx'))
    .map((rel) => rel.replace(/\/page\.tsx$/, ''))
    .sort();
}

describe('SETTINGS_SURFACE_PAGES is pinned to the operator route set', () => {
  const keys = Object.keys(SETTINGS_SURFACE_PAGES).sort();

  it('names exactly the sub-paths operator-vite routes under /settings', () => {
    expect(keys).toEqual(routeSubPaths());
  });

  it('has a row for every settings page module on disk', () => {
    // A subset, not equality: `publishing` mounts PublishingClient directly
    // (no page.tsx), so the route set above is the exact pin and this one
    // catches a page added without a row.
    for (const sub of pageSubPaths()) expect(keys, `settings/${sub}/page.tsx has no row`).toContain(sub);
  });

  it('defaults a bare /settings to a page that exists', () => {
    expect(isSettingsSubPath(DEFAULT_SETTINGS_SUBPATH)).toBe(true);
  });
});

describe('settingsSubPathFor', () => {
  it('maps the layout root and each sub-path, tolerating a trailing slash', () => {
    expect(settingsSubPathFor('/settings')).toBe(DEFAULT_SETTINGS_SUBPATH);
    expect(settingsSubPathFor('/settings/')).toBe(DEFAULT_SETTINGS_SUBPATH);
    expect(settingsSubPathFor('/settings/voice')).toBe('voice');
    expect(settingsSubPathFor('/settings/user/memory/')).toBe('user/memory');
  });

  it('returns null for a route the table does not mount', () => {
    expect(settingsSubPathFor('/settings/nope')).toBeNull();
    expect(settingsSubPathFor('/dev')).toBeNull();
    expect(settingsSubPathFor('/settingsx')).toBeNull();
  });
});
