/**
 * client-stream.test.ts — the client paths the existing client.test.ts leaves
 * uncovered:
 *   - subscribeToFlagStream: the EventSource-absent no-op, the SSE handler
 *     wiring (flag_changed → reload, flags_payload → apply, malformed → ignore),
 *     and close() delegating to the underlying source;
 *   - readInitialPayload seeding from globalThis.__PAPERCUSP_FLAGS__ at import.
 *
 * @papercusp/sse is mocked so subscribeToFlagStream's transport is a stub we
 * drive directly; no real EventSource / network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/sse', () => ({ createResilientEventSource: vi.fn() }));

import { createResilientEventSource } from '@papercusp/sse';
import {
  getFlagSnapshot,
  setFlagPayload,
  subscribeToFlagStream,
} from './client';
import { ALL_FLAG_KEYS, FLAG_DEFAULTS, type FlagPayload, type FlagValues } from './types';

const KEY = ALL_FLAG_KEYS[0];

type Handlers = Record<string, (data: string) => void>;

beforeEach(() => {
  vi.mocked(createResilientEventSource).mockReset();
  // reset the module store to all-defaults
  setFlagPayload({ flags: {} as FlagValues, evaluatedAt: 0, source: 'defaults' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToFlagStream — no EventSource', () => {
  it('returns an inert subscription and never opens a stream', () => {
    vi.stubGlobal('EventSource', undefined);
    const sub = subscribeToFlagStream();
    expect(createResilientEventSource).not.toHaveBeenCalled();
    // close() is a safe no-op
    expect(() => sub.close()).not.toThrow();
  });
});

describe('subscribeToFlagStream — wired transport', () => {
  function arrange() {
    vi.stubGlobal('EventSource', class FakeEventSource {});
    const close = vi.fn();
    vi.mocked(createResilientEventSource).mockReturnValue({ close } as unknown as ReturnType<
      typeof createResilientEventSource
    >);
    const sub = subscribeToFlagStream('/api/flags/stream');
    const call = vi.mocked(createResilientEventSource).mock.calls[0][0];
    return { sub, close, call, handlers: call.handlers as Handlers };
  }

  it('opens the resilient source with credentials + the endpoint url', () => {
    const { call } = arrange();
    expect(call.url).toBe('/api/flags/stream');
    expect(call.withCredentials).toBe(true);
  });

  it('flags_payload applies a JSON payload to the store', () => {
    const { handlers } = arrange();
    const payload: FlagPayload = {
      flags: { [KEY]: true } as FlagValues,
      evaluatedAt: 5,
      source: 'posthog',
    };
    handlers.flags_payload(JSON.stringify(payload));
    const snap = getFlagSnapshot();
    expect(snap.flags[KEY]).toBe(true);
    expect(snap.evaluatedAt).toBe(5);
    expect(snap.source).toBe('posthog');
  });

  it('flags_payload ignores malformed JSON (store unchanged, no throw)', () => {
    const { handlers } = arrange();
    const before = getFlagSnapshot();
    expect(() => handlers.flags_payload('{not-json')).not.toThrow();
    expect(getFlagSnapshot()).toEqual(before);
  });

  it('flag_changed triggers a reload via fetch', async () => {
    const { handlers } = arrange();
    const reloaded: FlagPayload = {
      flags: { [KEY]: true } as FlagValues,
      evaluatedAt: 11,
      source: 'posthog',
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(reloaded), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    handlers.flag_changed('');
    // loadFlags() is fire-and-forget inside the handler; let it settle.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/flags/bootstrap', { credentials: 'same-origin' }));
    await vi.waitFor(() => expect(getFlagSnapshot().flags[KEY]).toBe(true));
  });

  it('close() delegates to the underlying source', () => {
    const { sub, close } = arrange();
    sub.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('readInitialPayload — seed from globalThis.__PAPERCUSP_FLAGS__', () => {
  it('seeds the store from an injected SSR payload at import time', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__PAPERCUSP_FLAGS__ = {
      flags: { [KEY]: true },
      evaluatedAt: 99,
      source: 'posthog',
    };
    try {
      const fresh = await import('./client');
      const snap = fresh.getFlagSnapshot();
      expect(snap.evaluatedAt).toBe(99);
      expect(snap.source).toBe('posthog');
      expect(snap.flags[KEY]).toBe(true);
      // a partial seed still resolves to the full key set with defaults filled
      expect(Object.keys(snap.flags).sort()).toEqual([...ALL_FLAG_KEYS].sort());
      for (const k of ALL_FLAG_KEYS) {
        if (k === KEY) continue;
        expect(snap.flags[k]).toBe(FLAG_DEFAULTS[k]);
      }
    } finally {
      delete (globalThis as Record<string, unknown>).__PAPERCUSP_FLAGS__;
    }
  });
});
