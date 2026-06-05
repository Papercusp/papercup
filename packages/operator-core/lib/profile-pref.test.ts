/**
 * Coverage for profile-pref: the shared PG-backed preference plumbing.
 *   - fetchProfileOnce memoizes a single GET (+ force bypass, + {} on failure)
 *   - writeProfileField POSTs the field and invalidates the memo
 *   - writeProfileMapEntry read-modify-writes a nested map (merge + delete)
 *   - reconcileProfilePref adopts / skips / backs off on a concurrent local edit
 *
 * `inflight` is module-level, so each test re-imports the module (vi.resetModules)
 * for a clean memo. Global fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./profile-pref');

let mod: Mod;
let fetchMock: ReturnType<typeof vi.fn>;

/** A fetch stub whose GET /api/profile resolves `getPayload()` and whose POST
 *  resolves ok. Records calls for assertions. */
function installFetch(getPayload: () => unknown, ok = true) {
  fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    return Promise.resolve({ ok, json: () => Promise.resolve(getPayload()) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function postCalls() {
  return fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
}
function getCalls() {
  return fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method !== 'POST');
}
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(async () => {
  vi.resetModules();
  installFetch(() => ({}));
  mod = await import('./profile-pref');
});
afterEach(() => vi.unstubAllGlobals());

describe('fetchProfileOnce', () => {
  it('memoizes — two calls share one GET', async () => {
    installFetch(() => ({ theme_id: 'black' }));
    const a = await mod.fetchProfileOnce();
    const b = await mod.fetchProfileOnce();
    expect(a).toEqual({ theme_id: 'black' });
    expect(b).toBe(a); // same resolved object → same promise
    expect(getCalls()).toHaveLength(1);
  });

  it('force=true bypasses + refreshes the memo', async () => {
    installFetch(() => ({ theme_id: 'black' }));
    await mod.fetchProfileOnce();
    await mod.fetchProfileOnce(true);
    expect(getCalls()).toHaveLength(2);
  });

  it('resolves {} when the response is not ok', async () => {
    installFetch(() => ({ theme_id: 'black' }), false);
    expect(await mod.fetchProfileOnce()).toEqual({});
  });

  it('resolves {} when fetch throws', async () => {
    fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    expect(await mod.fetchProfileOnce()).toEqual({});
  });
});

describe('writeProfileField', () => {
  it('POSTs the single field and invalidates the memo', async () => {
    installFetch(() => ({ theme_id: 'frost' }));
    await mod.fetchProfileOnce(); // prime memo (1 GET)
    mod.writeProfileField('theme_id', 'black');
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/profile');
    expect(bodyOf(posts[0])).toEqual({ theme_id: 'black' });
    // Memo invalidated → next read re-GETs.
    await mod.fetchProfileOnce();
    expect(getCalls()).toHaveLength(2);
  });
});

describe('writeProfileMapEntry', () => {
  it('merges a key into the existing map without clobbering siblings', async () => {
    installFetch(() => ({ pi_dock_layouts: { a: 1 } }));
    await mod.writeProfileMapEntry('pi_dock_layouts', 'b', 2);
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toEqual({ pi_dock_layouts: { a: 1, b: 2 } });
  });

  it('deletes the entry when value is undefined', async () => {
    installFetch(() => ({ pi_dock_layouts: { a: 1, b: 2 } }));
    await mod.writeProfileMapEntry('pi_dock_layouts', 'a', undefined);
    expect(bodyOf(postCalls()[0])).toEqual({ pi_dock_layouts: { b: 2 } });
  });

  it('starts a fresh map when the field is absent', async () => {
    installFetch(() => ({}));
    await mod.writeProfileMapEntry('pi_dock_layouts', 'a', 1);
    expect(bodyOf(postCalls()[0])).toEqual({ pi_dock_layouts: { a: 1 } });
  });
});

describe('reconcileProfilePref', () => {
  it('adopts the PG value when it is valid and differs from current', async () => {
    installFetch(() => ({ theme_id: 'black' }));
    const adopt = vi.fn();
    const out = await mod.reconcileProfilePref<string>({
      field: 'theme_id',
      parse: (raw) => (typeof raw === 'string' ? raw : null),
      current: () => 'frost',
      adopt,
    });
    expect(out).toBe('black');
    expect(adopt).toHaveBeenCalledWith('black');
  });

  it('skips when the PG value equals the current cache', async () => {
    installFetch(() => ({ theme_id: 'frost' }));
    const adopt = vi.fn();
    const out = await mod.reconcileProfilePref<string>({
      field: 'theme_id',
      parse: (raw) => (typeof raw === 'string' ? raw : null),
      current: () => 'frost',
      adopt,
    });
    expect(out).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('skips when the PG field is missing / invalid', async () => {
    installFetch(() => ({}));
    const adopt = vi.fn();
    const out = await mod.reconcileProfilePref<string>({
      field: 'theme_id',
      parse: (raw) => (typeof raw === 'string' ? raw : null),
      current: () => 'frost',
      adopt,
    });
    expect(out).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('backs off (no clobber) when the user changed the value during the fetch', async () => {
    installFetch(() => ({ theme_id: 'black' }));
    const adopt = vi.fn();
    // current() returns the baseline first, then a DIFFERENT value (user edited
    // it while the GET was in flight) → reconcile must not adopt the stale PG read.
    const current = vi.fn<[], string>();
    current.mockReturnValueOnce('frost').mockReturnValue('white');
    const out = await mod.reconcileProfilePref<string>({
      field: 'theme_id',
      parse: (raw) => (typeof raw === 'string' ? raw : null),
      current,
      adopt,
    });
    expect(out).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('uses a custom equals for object-valued prefs', async () => {
    installFetch(() => ({ shortcut_overrides: { a: 'mod+z' } }));
    const adopt = vi.fn();
    // Same content, different object identity → custom equals must skip.
    const out = await mod.reconcileProfilePref<Record<string, string>>({
      field: 'shortcut_overrides',
      parse: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, string>) : null),
      current: () => ({ a: 'mod+z' }),
      equals: mod.shallowJsonEquals,
      adopt,
    });
    expect(out).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe('injectedPref', () => {
  it('returns undefined when there is no window / no injected prefs', () => {
    expect(mod.injectedPref('theme_id')).toBeUndefined();
  });

  it('reads a field off window.__PAPERCUSP_PREFS__', () => {
    vi.stubGlobal('window', { __PAPERCUSP_PREFS__: { theme_id: 'black', visual_effects_mode: 'minimal' } });
    expect(mod.injectedPref('theme_id')).toBe('black');
    expect(mod.injectedPref('visual_effects_mode')).toBe('minimal');
    expect(mod.injectedPref('missing')).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('shallowJsonEquals', () => {
  it('compares by JSON shape', () => {
    expect(mod.shallowJsonEquals({ a: 1 }, { a: 1 })).toBe(true);
    expect(mod.shallowJsonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(mod.shallowJsonEquals('x', 'x')).toBe(true);
  });
});
