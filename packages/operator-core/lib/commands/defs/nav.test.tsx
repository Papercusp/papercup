// @vitest-environment jsdom
/**
 * nav.test.tsx — the navigate command + the 8 fixed nav.* palette entries. The
 * genuine logic is navTo's workspace-context preservation: when the current URL
 * carries a `?ws=` param, navigation must carry it forward so the user doesn't
 * fall out of their workspace — but without double-appending when the target
 * already has one. Pins all four branches + encodeURIComponent + the fixed-nav
 * registration. Driven via the command registry (import registers; get(id) runs).
 *
 * navigateClient (the real router side-effect) is mocked — we assert the computed
 * target it's handed, not the navigation itself. jsdom env (navTo reads window).
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/commands/defs/nav.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client-navigation', () => ({ navigateClient: vi.fn() }));

import { navigateClient } from '../../client-navigation';
import './nav'; // side-effect: register(navigate) + the 8 FIXED_NAVS
import { get } from '../registry';

const navClient = vi.mocked(navigateClient);
const navigate = get('navigate')!;

const at = (url: string) => window.history.replaceState({}, '', url);
const target = () => navClient.mock.calls[0]![0] as string;

beforeEach(() => {
  navClient.mockClear();
  at('/admin'); // no ws by default
});
afterEach(() => vi.unstubAllGlobals());

describe('navTo — workspace (ws) preservation', () => {
  it('no ws in the current URL → path is unchanged', async () => {
    const out = (await navigate.handler({ path: '/foo' }, {} as never)) as { path: string };
    expect(out.path).toBe('/foo');
    expect(target()).toBe('/foo');
  });

  it('ws present + path has no query → appends ?ws=', async () => {
    at('/admin?ws=acme');
    const out = (await navigate.handler({ path: '/foo' }, {} as never)) as { path: string };
    expect(out.path).toBe('/foo?ws=acme');
    expect(target()).toBe('/foo?ws=acme');
  });

  it('ws present + path already has a query (no ws) → appends &ws=', async () => {
    at('/admin?ws=acme');
    const out = (await navigate.handler({ path: '/foo?tab=1' }, {} as never)) as { path: string };
    expect(out.path).toBe('/foo?tab=1&ws=acme');
  });

  it('does NOT double-append when the target already carries ws=', async () => {
    at('/admin?ws=acme');
    const out = (await navigate.handler({ path: '/foo?ws=other' }, {} as never)) as { path: string };
    expect(out.path).toBe('/foo?ws=other'); // left as-is, current ws ignored
  });

  it('URL-encodes the ws value', async () => {
    at('/admin?ws=' + encodeURIComponent('a b')); // ws = "a b"
    const out = (await navigate.handler({ path: '/foo' }, {} as never)) as { path: string };
    expect(out.path).toBe('/foo?ws=a%20b');
  });

  it('throws when run outside the browser (no window)', async () => {
    vi.stubGlobal('window', undefined);
    await expect(navigate.handler({ path: '/foo' }, {} as never)).rejects.toThrow(/must run in browser/);
    expect(navClient).not.toHaveBeenCalled();
  });
});

describe('fixed nav.* palette commands', () => {
  it('registers all eight fixed navs with a Navigate palette entry', () => {
    const ids = [
      'nav.papercusp', 'nav.cupboard', 'nav.installed-harnesses', 'nav.settings',
      'nav.settings-voice', 'nav.settings-api-keys', 'nav.settings-shortcuts', 'nav.docs',
    ];
    for (const id of ids) {
      const def = get(id);
      expect(def, id).toBeDefined();
      expect((def as { paletteEntry?: { section: string } }).paletteEntry?.section).toBe('Navigate');
    }
  });

  it('nav.docs navigates to /docs (carrying ws when present)', async () => {
    at('/admin?ws=acme');
    const out = (await get('nav.docs')!.handler({}, {} as never)) as { path: string };
    expect(out.path).toBe('/docs?ws=acme');
    expect(target()).toBe('/docs?ws=acme');
  });
});
