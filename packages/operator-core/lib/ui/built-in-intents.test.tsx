/**
 * @vitest-environment jsdom
 *
 * Tests for the built-in UI intents (the agent → page control surface):
 * registration + the set_url / snapshot / click / focus handlers.
 * Run with: cd packages/operator-core && npx vitest run lib/ui/built-in-intents.test.tsx
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
const { openRouteInApp } = vi.hoisted(() => ({ openRouteInApp: vi.fn(async () => {}) }));
vi.mock('../tauri-bindings', () => ({ commands: { openRouteInApp } }));
import { desktopHandoffRoute, registerBuiltInIntents } from './built-in-intents';
import { lookupIntent } from './intent-registry';

beforeAll(() => {
  // jsdom does not implement scrollIntoView; stub it so the scroll_into_view
  // found-branch does not emit a "Not implemented" console error (fail-on-console).
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  registerBuiltInIntents();
});

const call = (name: string, args: Record<string, unknown>) => lookupIntent(name)!.handler(args);

describe('terminal-to-desktop route identity', () => {
  it('preserves the exact report and workspace and accepts other object routes', () => {
    const current = 'http://localhost:3170/adv?ws=workspace-a';
    expect(desktopHandoffRoute('/reports?sel=rpt_abc-123', current)).toBe('/reports?sel=rpt_abc-123&ws=workspace-a');
    expect(desktopHandoffRoute('/reports/rpt_abc-123', current)).toBe('/reports?ws=workspace-a&sel=rpt_abc-123');
    expect(desktopHandoffRoute('/plans?sel=workbench#D-024', current)).toBe('/plans?sel=workbench&ws=workspace-a#D-024');
  });
  it('rejects external, protocol-relative, control-bearing and cross-workspace targets', () => {
    for (const route of ['https://example.com/reports', '//example.com', '/\\example.com', '/reports\n?sel=x', '/reports?ws=other']) {
      expect(() => desktopHandoffRoute(route, 'http://localhost:3170/adv?ws=workspace-a')).toThrow();
    }
  });
  it('requires a native client before requesting a handoff', async () => {
    await expect(call('native_window', { action: 'open_route', route: '/reports?sel=rpt_abc', expiresAt: Date.now() + 1000 })).rejects.toThrow(/native desktop/);
  });
  it('hands the exact route to the existing native command and rejects late requests', async () => {
    window.history.replaceState({}, '', '/adv?ws=workspace-a');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    try {
      await expect(call('native_window', { action: 'open_route', route: '/reports?sel=rpt_exact', expiresAt: Date.now() + 5000 }))
        .resolves.toEqual({ protocol: 'desktop-route-v1', requested: true, route: '/reports?sel=rpt_exact&ws=workspace-a' });
      expect(openRouteInApp).toHaveBeenLastCalledWith('/reports?sel=rpt_exact&ws=workspace-a');
      const count = openRouteInApp.mock.calls.length;
      await expect(call('native_window', { action: 'open_route', route: '/reports?sel=rpt_other', expiresAt: Date.now() - 1 })).rejects.toThrow(/expired/);
      expect(openRouteInApp).toHaveBeenCalledTimes(count);
    } finally { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; }
  });
});

describe('registerBuiltInIntents', () => {
  it('registers all six built-ins as builtIn:true', () => {
    for (const name of ['set_url', 'snapshot', 'read_visible_text', 'focus', 'scroll_into_view', 'click']) {
      const entry = lookupIntent(name);
      expect(entry, name).toBeDefined();
      expect(entry?.builtIn).toBe(true);
    }
  });

  it('is idempotent (a second call does not throw or duplicate)', () => {
    expect(() => registerBuiltInIntents()).not.toThrow();
    expect(lookupIntent('set_url')).toBeDefined();
  });
});

describe('set_url intent', () => {
  it('merges params into the URL query', async () => {
    window.history.replaceState({}, '', '/admin?ws=default');
    await call('set_url', { params: { tab: 'plans' } });
    expect(window.location.search).toContain('tab=plans');
    expect(window.location.search).toContain('ws=default'); // merge keeps existing
  });

  it('deletes a param when its value is null', async () => {
    window.history.replaceState({}, '', '/admin?tab=plans&ws=default');
    await call('set_url', { params: { tab: null } });
    expect(window.location.search).not.toContain('tab=');
    expect(window.location.search).toContain('ws=default');
  });

  it('replace mode clears existing params first', async () => {
    window.history.replaceState({}, '', '/admin?a=1&b=2');
    await call('set_url', { params: { c: '3' }, mode: 'replace' });
    expect(window.location.search).toBe('?c=3');
  });

  it('path switches the route while params merge (P-018 GUI tab-tour)', async () => {
    window.history.replaceState({}, '', '/harness?ws=default');
    await call('set_url', { path: '/adv', params: { tab: 'overview' } });
    expect(window.location.pathname).toBe('/adv');
    expect(window.location.search).toContain('tab=overview');
    expect(window.location.search).toContain('ws=default'); // params still merge
  });

  it('path alone (no params) navigates and keeps the existing query', async () => {
    window.history.replaceState({}, '', '/admin?ws=default');
    await call('set_url', { path: '/harness' });
    expect(window.location.pathname).toBe('/harness');
    expect(window.location.search).toContain('ws=default');
  });

  it('rejects a non-relative path (same-origin only — never a full URL)', () => {
    window.history.replaceState({}, '', '/admin');
    expect(() => call('set_url', { path: 'https://evil.example/x' })).toThrow(/path must start with/);
    expect(window.location.pathname).toBe('/admin'); // unchanged
  });

  it('dispatches a popstate so nuqs/Next subscribers re-read the URL', async () => {
    // The whole point of set_url over a plain history.replaceState: it fires a
    // popstate so URL-state subscribers refresh. Dropping it would silently break
    // every agent-driven navigation (the URL changes but nothing re-renders).
    window.history.replaceState({}, '', '/admin');
    let fired = 0;
    const onPop = () => { fired += 1; };
    window.addEventListener('popstate', onPop);
    try {
      await call('set_url', { params: { tab: 'plans' } });
    } finally {
      window.removeEventListener('popstate', onPop);
    }
    expect(fired).toBe(1);
  });
});

describe('snapshot / read_visible_text intents', () => {
  it('returns text content for a matched selector and found:false otherwise', async () => {
    document.body.innerHTML = '<div id="t">hello world</div>';
    const found = (await call('snapshot', { selector: '#t', mode: 'textContent' })) as { found: boolean; text: string };
    expect(found.found).toBe(true);
    expect(found.text).toBe('hello world');
    const missing = (await call('read_visible_text', { selector: '#nope' })) as { found: boolean };
    expect(missing.found).toBe(false);
  });
});

describe('click / focus intents', () => {
  it('clicks a matched element', async () => {
    let clicked = false;
    document.body.innerHTML = '<button id="b">go</button>';
    document.querySelector('#b')!.addEventListener('click', () => { clicked = true; });
    const res = (await call('click', { selector: '#b' })) as { found: boolean };
    expect(res.found).toBe(true);
    expect(clicked).toBe(true);
  });

  it('throws when a required selector is missing', () => {
    // The built-in handlers are synchronous, so the throw is synchronous too.
    expect(() => call('click', {})).toThrow(/selector required/);
  });

  it('click returns found:false for a selector that matches nothing', async () => {
    const res = (await call('click', { selector: '#gone' })) as { found: boolean };
    expect(res.found).toBe(false);
  });
});

describe('snapshot depth branches', () => {
  beforeAll(() => {
    document.body.innerHTML = '<div id="t">hello world</div>';
  });

  it('returns found:false (text:null) for a selector that matches nothing', async () => {
    const res = (await call('snapshot', { selector: '#nope' })) as { found: boolean; text: unknown };
    expect(res.found).toBe(false);
    expect(res.text).toBeNull();
  });

  it('truncates with a marker past maxLength', async () => {
    const res = (await call('snapshot', { selector: '#t', mode: 'textContent', maxLength: 5 })) as { text: string };
    expect(res.text.startsWith('hello')).toBe(true);
    expect(res.text).toContain('…truncated at 5 chars');
  });

  it('returns markup in outerHTML mode', async () => {
    const res = (await call('snapshot', { selector: '#t', mode: 'outerHTML' })) as { text: string };
    expect(res.text).toContain('<div');
    expect(res.text).toContain('id="t"');
  });

  it('read_visible_text returns found:true with a string for a present element', async () => {
    document.body.innerHTML = '<p id="p">visible</p>';
    const res = (await call('read_visible_text', { selector: '#p' })) as { found: boolean; text: unknown };
    expect(res.found).toBe(true);
    expect(typeof res.text).toBe('string');
  });
});

describe('focus intent', () => {
  it('throws when no selector is given', () => {
    expect(() => call('focus', {})).toThrow(/selector required/);
  });

  it('returns found:false for a missing element', async () => {
    const res = (await call('focus', { selector: '#gone' })) as { found: boolean };
    expect(res.found).toBe(false);
  });

  it('focuses a present focusable element', async () => {
    document.body.innerHTML = '<button id="fb">go</button>';
    const res = (await call('focus', { selector: '#fb' })) as { found: boolean; activeElementMatches: unknown };
    expect(res.found).toBe(true);
    expect(typeof res.activeElementMatches).toBe('boolean');
  });
});

describe('scroll_into_view intent', () => {
  it('throws when no selector is given', () => {
    expect(() => call('scroll_into_view', {})).toThrow(/selector required/);
  });

  it('returns found:false for a missing element', async () => {
    const res = (await call('scroll_into_view', { selector: '#gone' })) as { found: boolean };
    expect(res.found).toBe(false);
  });

  it('returns found:true for a present element', async () => {
    document.body.innerHTML = '<div id="s">x</div>';
    const res = (await call('scroll_into_view', { selector: '#s' })) as { found: boolean };
    expect(res.found).toBe(true);
  });
});
