/**
 * Coverage for shortcut-registry: getShortcutDef lookup, effectiveCombo
 * (override wins over defaultCombo; unknown id → ''), and the localStorage
 * override store (load/save/delete-on-empty/reset-all) against a stubbed window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHORTCUTS,
  getShortcutDef,
  effectiveCombo,
  loadOverrides,
  saveOverride,
  resetAllOverrides,
} from './shortcut-registry';

const FIRST = SHORTCUTS[0];
const KEY = 'pc:ws:default:papercusp.shortcuts.v1';

function stubWindow() {
  const store = new Map<string, string>();
  const dispatchEvent = vi.fn();
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent,
    location: { href: 'http://127.0.0.1:3070/' },
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  return { store, dispatchEvent, fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe('getShortcutDef', () => {
  it('returns the def for a known id, undefined otherwise', () => {
    expect(getShortcutDef(FIRST.id)).toBe(FIRST);
    expect(getShortcutDef('definitely-not-a-shortcut')).toBeUndefined();
  });
});

describe('effectiveCombo', () => {
  it('uses the defaultCombo when no override is present', () => {
    expect(effectiveCombo(FIRST.id, {})).toBe(FIRST.defaultCombo.trim());
  });
  it('prefers an override', () => {
    expect(effectiveCombo(FIRST.id, { [FIRST.id]: 'mod+z' })).toBe('mod+z');
  });
  it('returns empty string for an unknown id', () => {
    expect(effectiveCombo('nope', {})).toBe('');
  });
});

describe('override store', () => {
  it('loadOverrides returns {} under SSR / when unset', () => {
    expect(loadOverrides()).toEqual({}); // no window
  });

  it('loadOverrides parses stored JSON', () => {
    const { store } = stubWindow();
    store.set(KEY, JSON.stringify({ 'feature.x': 'mod+y' }));
    expect(loadOverrides()).toEqual({ 'feature.x': 'mod+y' });
  });

  it('loadOverrides tolerates malformed JSON', () => {
    const { store } = stubWindow();
    store.set(KEY, '{not json');
    expect(loadOverrides()).toEqual({});
  });

  it('saveOverride persists (trimmed) + notifies; empty combo deletes', () => {
    const { store, dispatchEvent } = stubWindow();
    saveOverride('feature.x', '  mod+z  ');
    expect(JSON.parse(store.get(KEY)!)).toEqual({ 'feature.x': 'mod+z' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    saveOverride('feature.x', '   '); // whitespace → delete
    expect(JSON.parse(store.get(KEY)!)).toEqual({});
  });

  it('resetAllOverrides clears the key + notifies', () => {
    const { store, dispatchEvent } = stubWindow();
    store.set(KEY, JSON.stringify({ a: 'b' }));
    resetAllOverrides();
    expect(store.get(KEY)).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('saveOverride pushes the full override map to PG (/api/profile)', () => {
    const { fetchMock } = stubWindow();
    saveOverride('feature.x', 'mod+z');
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(post?.[0]).toBe('/api/profile');
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({
      shortcut_overrides: { 'feature.x': 'mod+z' },
    });
  });
});
