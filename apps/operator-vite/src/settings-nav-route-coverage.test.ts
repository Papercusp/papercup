/**
 * Route-coverage guard for the settings left-nav (p2p-work-distribution P-002).
 *
 * The operator UI is operator-vite (TanStack file-based router under
 * src/routes/); every settings page needs BOTH a page component in
 * apps/operator/app/settings/<x>/page.tsx AND a thin operator-vite route
 * wrapper src/routes/settings/<x>.tsx (the page-import pattern). Ship the page
 * without the wrapper and the nav link renders but the route is UNREACHABLE
 * (chrome only, no page content).
 *
 * This has bitten twice — /settings/p2p and /settings/hive-customization both
 * shipped nav-listed but wrapper-less. This test fails if any settings link in
 * SETTINGS_GROUPS (apps/operator/app/settings/layout.tsx) lacks a matching
 * operator-vite route file, so the whole class can't recur silently.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/operator-vite/src
const repoRoot = resolve(here, '../../..');
const routesDir = resolve(here, 'routes');
const layoutPath = resolve(repoRoot, 'apps/operator/app/settings/layout.tsx');

/** Extract every SettingsLink href in SETTINGS_GROUPS (`href: '/settings/…'`). */
function settingsNavHrefs(): string[] {
  const src = readFileSync(layoutPath, 'utf8');
  const hrefs = [...src.matchAll(/href:\s*'(\/settings\/[^']+)'/g)].map((m) => m[1]);
  return [...new Set(hrefs)];
}

/**
 * TanStack file-based routing derives the route path FROM the filename, so a
 * route at path /settings/<sub> must live at routes/settings/<sub>.tsx or
 * routes/settings/<sub>/index.tsx — file existence is authoritative.
 */
function hasRouteFile(href: string): boolean {
  const sub = href.replace(/^\/settings\//, '');
  return (
    existsSync(resolve(routesDir, 'settings', `${sub}.tsx`)) ||
    existsSync(resolve(routesDir, 'settings', sub, 'index.tsx'))
  );
}

describe('settings nav → operator-vite route coverage', () => {
  it('finds settings nav hrefs to check', () => {
    const hrefs = settingsNavHrefs();
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs).toContain('/settings/p2p');
    expect(hrefs).toContain('/settings/hive-customization');
  });

  it('every settings nav link has an operator-vite route wrapper', () => {
    const missing = settingsNavHrefs().filter((href) => !hasRouteFile(href));
    expect(
      missing,
      `settings nav links with no operator-vite route file (unreachable in the live app): ${missing.join(', ')}. ` +
        `Add src/routes${'/settings'}/<sub>.tsx re-exporting @/app<href>/page (page-import pattern; see settings/trust.tsx).`,
    ).toEqual([]);
  });
});
