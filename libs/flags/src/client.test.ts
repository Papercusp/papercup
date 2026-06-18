/**
 * client.test.ts — flag-read defaulting + the client store (P-022 of
 * test-coverage-rest-non-critical). The client is the browser/Tauri-safe flag
 * reader: it must always resolve to a boolean (falling back to FLAG_DEFAULTS),
 * apply payloads through resolveWithDefaults (so a partial payload never drops
 * a flag), notify subscribers, and load over fetch.
 *
 * @papercusp/sse is mocked — subscribeToFlagStream isn't under test here and the
 * mock keeps the import off the (submodule) SSE lib.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/sse', () => ({ createResilientEventSource: vi.fn() }));

import {
  getFlag,
  getFlagSnapshot,
  setFlagPayload,
  subscribe,
  loadFlags,
} from './client';
import {
  ALL_FLAG_KEYS,
  FLAG_DEFAULTS,
  type FlagPayload,
  type FlagValues,
} from './types';

const KEY = ALL_FLAG_KEYS[0];
const OTHER = ALL_FLAG_KEYS[1];

// The store is module-level; reset to all-defaults before each test.
beforeEach(() => {
  setFlagPayload({ flags: {} as FlagValues, evaluatedAt: 0, source: 'defaults' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getFlag — defaulting', () => {
  it('returns the FLAG_DEFAULTS value for the initial state', () => {
    for (const k of ALL_FLAG_KEYS) {
      expect(getFlag(k)).toBe(FLAG_DEFAULTS[k]);
    }
  });

  it('reflects a value set via setFlagPayload', () => {
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    expect(getFlag(KEY)).toBe(true);
  });

  it('a partial payload still defaults every unset flag (resolveWithDefaults)', () => {
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    expect(getFlag(KEY)).toBe(true);
    expect(getFlag(OTHER)).toBe(false); // unset → default
    // every key resolves to a boolean
    for (const k of ALL_FLAG_KEYS) expect(typeof getFlag(k)).toBe('boolean');
  });
});

describe('getFlagSnapshot', () => {
  it('returns the resolved payload (flags + evaluatedAt + source)', () => {
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 42, source: 'override' });
    const snap = getFlagSnapshot();
    expect(snap.source).toBe('override');
    expect(snap.evaluatedAt).toBe(42);
    expect(snap.flags[KEY]).toBe(true);
    expect(snap.flags[OTHER]).toBe(false);
    // resolved to the full key set
    expect(Object.keys(snap.flags).sort()).toEqual([...ALL_FLAG_KEYS].sort());
  });
});

describe('subscribe', () => {
  it('notifies on setFlagPayload and stops after unsubscribe', () => {
    const seen: FlagValues[] = [];
    const unsub = subscribe((f) => seen.push(f));
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    expect(seen).toHaveLength(1);
    expect(seen[0][KEY]).toBe(true);

    unsub();
    setFlagPayload({ flags: { [KEY]: false } as FlagValues, evaluatedAt: 2, source: 'posthog' });
    expect(seen).toHaveLength(1); // no further notification
  });
});

describe('loadFlags', () => {
  it('fetches, applies the payload, and returns the resolved snapshot', async () => {
    const payload: FlagPayload = {
      flags: { [KEY]: true } as FlagValues,
      evaluatedAt: 7,
      source: 'posthog',
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadFlags('/api/flags/bootstrap');
    expect(fetchMock).toHaveBeenCalledWith('/api/flags/bootstrap', { credentials: 'same-origin' });
    expect(result.flags[KEY]).toBe(true);
    expect(getFlag(KEY)).toBe(true); // store updated
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(loadFlags('/api/flags/bootstrap')).rejects.toThrow(/HTTP 500/);
  });
});
