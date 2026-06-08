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
});
