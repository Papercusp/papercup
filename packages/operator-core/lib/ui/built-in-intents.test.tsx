/**
 * @vitest-environment jsdom
 *
 * Tests for the built-in UI intents (the agent → page control surface):
 * registration + the set_url / snapshot / click / focus handlers.
 * Run with: cd packages/operator-core && npx vitest run lib/ui/built-in-intents.test.tsx
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltInIntents } from './built-in-intents';
import { lookupIntent } from './intent-registry';

beforeAll(() => {
  // jsdom does not implement scrollIntoView; stub it so the scroll_into_view
  // found-branch does not emit a "Not implemented" console error (fail-on-console).
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  registerBuiltInIntents();
});

const call = (name: string, args: Record<string, unknown>) => lookupIntent(name)!.handler(args);

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
