/**
 * server-backend.test.ts — the server flag backend paths the existing
 * server.test.ts (offline-only mode) leaves uncovered:
 *   - the PAPERCUSP_FLAG_<KEY> env override + its precedence over test overrides;
 *   - the *configured* getFlag / getAllFlags paths (PostHog client mocked) incl.
 *     the swallow-to-default branches;
 *   - initFlagBackend / isBackendConfigured / getBackendConfig lifecycle;
 *   - setFlag's PostHog REST round-trip (list → patch) and every failure reason;
 *   - the onFlagChange / emitFlagChange handler registry (incl. throw-swallow).
 *
 * posthog-node is mocked so no network is touched. fetch is stubbed per-test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock for the PostHog client instance `initFlagBackend` constructs.
// Use a real `class` (not `vi.fn(() => …)`): vitest 4 warns when a vi.fn() is
// invoked with `new`, and setup-fail-on-console turns that warn into a failure.
const ph = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  shutdown: vi.fn(),
}));
vi.mock('posthog-node', () => ({
  PostHog: class {
    isFeatureEnabled = ph.isFeatureEnabled;
    shutdown = ph.shutdown;
  },
}));

import {
  getAllFlags,
  getFlag,
  initFlagBackend,
  isBackendConfigured,
  getBackendConfig,
  setFlag,
  onFlagChange,
  emitFlagChange,
  type PostHogConfig,
} from './server';
import { setFlagOverridesForTest } from './test';
import { FLAGS, FLAG_DEFAULTS } from './types';

const CFG: PostHogConfig = {
  host: 'https://flags.example.test',
  projectKey: 'phc_project',
  personalApiKey: 'phx_personal',
};

function clearFlagEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PAPERCUSP_FLAG_')) delete process.env[k];
  }
}

beforeEach(() => {
  ph.isFeatureEnabled.mockReset();
  ph.shutdown.mockReset();
  initFlagBackend(null);
  setFlagOverridesForTest(null);
  clearFlagEnv();
});

afterEach(() => {
  initFlagBackend(null);
  setFlagOverridesForTest(null);
  clearFlagEnv();
  vi.unstubAllGlobals();
});

describe('env override (PAPERCUSP_FLAG_<KEY>)', () => {
  // key 'papercusp-testing' → PAPERCUSP_FLAG_PAPERCUSP_TESTING
  const ENV_KEY = 'PAPERCUSP_FLAG_PAPERCUSP_TESTING';

  it('"1" and "true"/"TRUE" enable; "0"/"false"/other disable', async () => {
    for (const truthy of ['1', 'true', 'TRUE', 'True']) {
      process.env[ENV_KEY] = truthy;
      expect(await getFlag(FLAGS.TESTING, 'u')).toBe(true);
    }
    for (const falsy of ['0', 'false', 'no', 'yes', '']) {
      process.env[ENV_KEY] = falsy;
      expect(await getFlag(FLAGS.TESTING, 'u')).toBe(false);
    }
  });

  it('takes precedence over an in-process test override', async () => {
    setFlagOverridesForTest({ [FLAGS.TESTING]: false });
    process.env[ENV_KEY] = '1';
    expect(await getFlag(FLAGS.TESTING, 'u')).toBe(true);
  });

  it('an unset env var leaves the normal resolution path intact', async () => {
    // no env, no backend → default
    expect(await getFlag(FLAGS.TESTING, 'u')).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
  });
});

describe('getFlag — in-process test override (no env, no backend)', () => {
  it('returns the override value resolved over defaults', async () => {
    setFlagOverridesForTest({ [FLAGS.TESTING]: true });
    expect(await getFlag(FLAGS.TESTING, 'u')).toBe(true);
    // un-listed flag falls through the override map to its default
    expect(await getFlag(FLAGS.DESIGN, 'u')).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
  });
});

describe('backend lifecycle', () => {
  it('initFlagBackend(cfg) marks the backend configured and exposes the config', () => {
    expect(isBackendConfigured()).toBe(false);
    expect(getBackendConfig()).toBeNull();
    initFlagBackend(CFG);
    expect(isBackendConfigured()).toBe(true);
    expect(getBackendConfig()).toEqual(CFG);
  });

  it('re-init shuts the previous client down; init(null) clears config', () => {
    initFlagBackend(CFG);
    initFlagBackend(CFG); // re-init → previous client.shutdown()
    expect(ph.shutdown).toHaveBeenCalledTimes(1);
    initFlagBackend(null); // clears → shutdown again
    expect(ph.shutdown).toHaveBeenCalledTimes(2);
    expect(isBackendConfigured()).toBe(false);
    expect(getBackendConfig()).toBeNull();
  });
});

describe('getFlag — configured (PostHog client mocked)', () => {
  beforeEach(() => initFlagBackend(CFG));

  it('returns the client boolean when PostHog answers', async () => {
    ph.isFeatureEnabled.mockResolvedValue(true);
    expect(await getFlag(FLAGS.DESIGN, 'u')).toBe(true);
    expect(ph.isFeatureEnabled).toHaveBeenCalledWith(FLAGS.DESIGN, 'u');
  });

  it('falls back to the default when PostHog returns a non-boolean', async () => {
    ph.isFeatureEnabled.mockResolvedValue(undefined);
    expect(await getFlag(FLAGS.DESIGN, 'u')).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
  });

  it('falls back to the default when the client throws (fail-safe-closed)', async () => {
    ph.isFeatureEnabled.mockRejectedValue(new Error('posthog down'));
    expect(await getFlag(FLAGS.TESTING, 'u')).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
  });

  it('falls back to the default when the client never resolves (fail-fast bootstrap)', async () => {
    process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS = '1';
    ph.isFeatureEnabled.mockImplementation(() => new Promise(() => {}));
    expect(await getFlag(FLAGS.TESTING, 'u')).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
  });
});

describe('getAllFlags — configured (PostHog client mocked)', () => {
  beforeEach(() => initFlagBackend(CFG));

  it('merges evaluated values over defaults and reports source=posthog', async () => {
    ph.isFeatureEnabled.mockImplementation(async (key: string) =>
      key === FLAGS.TESTING ? true : undefined,
    );
    const payload = await getAllFlags('u');
    expect(payload.source).toBe('posthog');
    expect(payload.flags[FLAGS.TESTING]).toBe(true); // evaluated
    expect(payload.flags[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]); // non-boolean → default
  });

  it('a per-key evaluation throw degrades that key to its default, not a crash', async () => {
    ph.isFeatureEnabled.mockImplementation(async (key: string) => {
      if (key === FLAGS.DESIGN) throw new Error('boom');
      return undefined;
    });
    const payload = await getAllFlags('u');
    expect(payload.source).toBe('posthog');
    expect(payload.flags[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
  });

  it('a never-resolving backend evaluation degrades the bootstrap payload to defaults', async () => {
    process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS = '1';
    ph.isFeatureEnabled.mockImplementation(() => new Promise(() => {}));
    const payload = await getAllFlags('u');
    expect(payload.source).toBe('posthog');
    expect(payload.flags[FLAGS.TESTING]).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
    expect(payload.flags[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
    expect(ph.isFeatureEnabled).toHaveBeenCalled();
  });
});

describe('setFlag — PostHog REST round-trip', () => {
  it('returns flag-backend-not-configured when no config is set', async () => {
    // beforeEach left the backend at null
    const res = await setFlag(FLAGS.TESTING, true);
    expect(res).toEqual({ ok: false, reason: 'flag-backend-not-configured' });
  });

  it('enable: PATCHes active=true + rollout 100 for the matched flag id', async () => {
    initFlagBackend(CFG);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 7, key: FLAGS.TESTING, active: false }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await setFlag(FLAGS.TESTING, true);
    expect(res).toEqual({ ok: true });

    // list call: search by key
    const [listUrl, listInit] = fetchMock.mock.calls[0];
    expect(listUrl).toBe(
      `${CFG.host}/api/projects/@current/feature_flags/?search=${encodeURIComponent(FLAGS.TESTING)}`,
    );
    expect((listInit as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${CFG.personalApiKey}`,
    });

    // patch call: by id, active + rollout 100
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect(patchUrl).toBe(`${CFG.host}/api/projects/@current/feature_flags/7/`);
    expect((patchInit as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((patchInit as RequestInit).body as string);
    expect(body.active).toBe(true);
    expect(body.filters.groups[0].rollout_percentage).toBe(100);
  });

  it('disable: PATCHes active=false + rollout 0', async () => {
    initFlagBackend(CFG);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 3, key: FLAGS.TESTING, active: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await setFlag(FLAGS.TESTING, false);
    expect(res).toEqual({ ok: true });
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.active).toBe(false);
    expect(body.filters.groups[0].rollout_percentage).toBe(0);
  });

  it('reports list:<status> when the list request is not ok', async () => {
    initFlagBackend(CFG);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })));
    expect(await setFlag(FLAGS.TESTING, true)).toEqual({ ok: false, reason: 'list:403' });
  });

  it('reports flag-not-found-in-posthog when no result matches the key', async () => {
    initFlagBackend(CFG);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 1, key: 'some-other-flag', active: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(await setFlag(FLAGS.TESTING, true)).toEqual({
      ok: false,
      reason: 'flag-not-found-in-posthog',
    });
  });

  it('reports patch:<status> when the patch request is not ok', async () => {
    initFlagBackend(CFG);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 9, key: FLAGS.TESTING, active: false }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await setFlag(FLAGS.TESTING, true)).toEqual({ ok: false, reason: 'patch:400' });
  });

  it('captures a thrown fetch error as the failure reason', async () => {
    initFlagBackend(CFG);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    expect(await setFlag(FLAGS.TESTING, true)).toEqual({
      ok: false,
      reason: 'network unreachable',
    });
  });

  it('reports "unknown" when a non-Error value is thrown', async () => {
    initFlagBackend(CFG);
    // eslint-disable-next-line prefer-promise-reject-errors
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('a bare string, not an Error'));
    expect(await setFlag(FLAGS.TESTING, true)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('onFlagChange / emitFlagChange', () => {
  it('notifies a registered handler with the changed key, and null for a broad change', () => {
    const seen: (string | null)[] = [];
    const off = onFlagChange((k) => seen.push(k));
    emitFlagChange(FLAGS.TESTING);
    emitFlagChange(null);
    off();
    expect(seen).toEqual([FLAGS.TESTING, null]);
  });

  it('stops notifying after the returned unsubscribe', () => {
    const seen: (string | null)[] = [];
    const off = onFlagChange((k) => seen.push(k));
    off();
    emitFlagChange(FLAGS.DESIGN);
    expect(seen).toEqual([]);
  });

  it('swallows a throwing handler and still dispatches to the others', () => {
    const seen: (string | null)[] = [];
    const offThrow = onFlagChange(() => {
      throw new Error('handler blew up');
    });
    const offOk = onFlagChange((k) => seen.push(k));
    expect(() => emitFlagChange(FLAGS.TESTING)).not.toThrow();
    expect(seen).toEqual([FLAGS.TESTING]);
    offThrow();
    offOk();
  });
});
