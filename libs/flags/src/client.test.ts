// @vitest-environment jsdom
//
/**
 * client.test.ts — flag-read defaulting + the client store (P-022 of
 * test-coverage-rest-non-critical). The client is the browser/Tauri-safe flag
 * reader: it must always resolve to a boolean (falling back to FLAG_DEFAULTS),
 * apply payloads through resolveWithDefaults (so a partial payload never drops
 * a flag), notify subscribers, and load over fetch.
 *
 * @papercusp/sse is mocked — subscribeToFlagStream isn't under test here and the
 * mock keeps the import off the (submodule) SSE lib.
 *
 * EI-2425 fix A: `useFlag` is now a REAL React hook (useSyncExternalStore over
 * the store below), so it can no longer be called bare outside a component
 * render (React throws "Invalid hook call"). The defaulting/value tests below
 * use `@testing-library/react`'s `renderHook` (hence the jsdom environment
 * pragma above — renderHook needs a DOM to mount its throwaway host).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@papercusp/sse', () => ({ createResilientEventSource: vi.fn() }));

import {
  useFlag,
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

// These tests assert that an UNSET flag resolves to `false`, so they need keys whose
// DEFAULT is false. FLAG_DEFAULTS is derived (`!DARK_FLAGS.has(k)`), so all but the ~31
// dark flags default ON — indexing ALL_FLAG_KEYS blindly silently binds KEY to whatever
// flag happens to be registered first and breaks the moment that one defaults ON. It did:
// 'papercusp-pg-mutate-tool' landed at index 0 and red-pinned the gate. Derive instead.
const DEFAULT_OFF_KEYS = ALL_FLAG_KEYS.filter((k) => FLAG_DEFAULTS[k] === false);
// Guard the premise: if the dark set ever empties, fail loudly here rather than as a
// baffling `expected true to be false` deep inside a re-render assertion.
if (DEFAULT_OFF_KEYS.length < 2) {
  throw new Error(
    `client.test.ts needs 2 default-OFF flags to test defaulting; found ${DEFAULT_OFF_KEYS.length}.`,
  );
}
const KEY = DEFAULT_OFF_KEYS[0];
const OTHER = DEFAULT_OFF_KEYS[1];

// The store is module-level; reset to all-defaults before each test.
beforeEach(() => {
  setFlagPayload({ flags: {} as FlagValues, evaluatedAt: 0, source: 'defaults' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFlag — defaulting', () => {
  it('returns the FLAG_DEFAULTS value for the initial state', () => {
    for (const k of ALL_FLAG_KEYS) {
      const { result } = renderHook(() => useFlag(k));
      expect(result.current).toBe(FLAG_DEFAULTS[k]);
    }
  });

  it('reflects a value set via setFlagPayload BEFORE the hook mounts', () => {
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    const { result } = renderHook(() => useFlag(KEY));
    expect(result.current).toBe(true);
  });

  it('a partial payload still defaults every unset flag (resolveWithDefaults)', () => {
    setFlagPayload({ flags: { [KEY]: true } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    expect(renderHook(() => useFlag(KEY)).result.current).toBe(true);
    expect(renderHook(() => useFlag(OTHER)).result.current).toBe(FLAG_DEFAULTS[OTHER]); // unset → default
    // every key resolves to a boolean
    for (const k of ALL_FLAG_KEYS) {
      expect(typeof renderHook(() => useFlag(k)).result.current).toBe('boolean');
    }
  });

  it('EI-2425 fix A: a MOUNTED hook re-renders live when setFlagPayload changes the flag — the exact bug this fixes (a plain function read never updated an already-rendered consumer)', () => {
    // KEY is default-OFF by construction (see DEFAULT_OFF_KEYS above), but drive the
    // transitions off its ACTUAL default rather than a hardcoded literal so this test
    // states its own premise. A literal would not just break if that binding changed —
    // it would silently GUT the test, because setting an already-true flag to `true`
    // is a no-op that re-renders nothing and would still pass.
    const initial = FLAG_DEFAULTS[KEY];
    const { result } = renderHook(() => useFlag(KEY));
    expect(result.current).toBe(initial); // default

    act(() => {
      setFlagPayload({ flags: { [KEY]: !initial } as FlagValues, evaluatedAt: 1, source: 'posthog' });
    });
    expect(result.current).toBe(!initial); // re-rendered with the NEW value, no remount

    act(() => {
      setFlagPayload({ flags: { [KEY]: initial } as FlagValues, evaluatedAt: 2, source: 'posthog' });
    });
    expect(result.current).toBe(initial); // flips back live too
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
    expect(renderHook(() => useFlag(KEY)).result.current).toBe(true); // store updated
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(loadFlags('/api/flags/bootstrap')).rejects.toThrow(/HTTP 500/);
  });
});
