/**
 * Persistent runtime-override layer (audit P-070, EI-76).
 *
 * Precedence under test: env var > test overrides > stored override >
 * PostHog/defaults. The store is injected (Papercusp wires a PG-backed one
 * in operator-core's flag-bus); here a fake in-memory store stands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllFlagOverrides,
  getAllFlags,
  getFlag,
  initFlagBackend,
  initFlagOverrideStore,
  isOverrideStoreConfigured,
  resetOverrideStoreWarningForTest,
  setFlagOverride,
  type FlagOverrideStore,
} from './server';
import { setFlagOverridesForTest } from './test';
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from './types';

const KEY = FLAGS.TESTING; // default false — a visible flip target
const ENV_KEY = `PAPERCUSP_FLAG_${KEY.toUpperCase().replace(/-/g, '_')}`;

function makeFakeStore(initial: Partial<Record<FlagKey, boolean>> = {}) {
  const map: Partial<Record<FlagKey, boolean>> = { ...initial };
  let loads = 0;
  const store: FlagOverrideStore = {
    async load() {
      loads++;
      return { ...map };
    },
    async set(key, enabled) {
      if (enabled === null) delete map[key];
      else map[key] = enabled;
    },
  };
  return { store, map, loads: () => loads };
}

beforeEach(() => {
  initFlagBackend(null);
  setFlagOverridesForTest(null);
  delete process.env[ENV_KEY];
});

afterEach(() => {
  initFlagOverrideStore(null);
  setFlagOverridesForTest(null);
  delete process.env[ENV_KEY];
});

describe('flag override store', () => {
  it('without a store, behavior is unchanged (defaults)', async () => {
    initFlagOverrideStore(null);
    expect(isOverrideStoreConfigured()).toBe(false);
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]);
    const r = await setFlagOverride(KEY, true);
    expect(r).toEqual({ ok: false, reason: 'override-store-not-configured' });
  });

  it('a stored override beats the default', async () => {
    const { store } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, 'u')).toBe(!FLAG_DEFAULTS[KEY]);
  });

  it('env var beats a stored override', async () => {
    const { store } = makeFakeStore({ [KEY]: false });
    initFlagOverrideStore(store);
    process.env[ENV_KEY] = '1';
    expect(await getFlag(KEY, 'u')).toBe(true);
  });

  it('test overrides beat a stored override', async () => {
    const { store } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    setFlagOverridesForTest({ [KEY]: false });
    expect(await getFlag(KEY, 'u')).toBe(false);
  });

  it('setFlagOverride writes through and is visible immediately (cache busted)', async () => {
    const { store, map } = makeFakeStore();
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]); // cache primed

    expect(await setFlagOverride(KEY, !FLAG_DEFAULTS[KEY])).toEqual({ ok: true });
    expect(map[KEY]).toBe(!FLAG_DEFAULTS[KEY]);
    expect(await getFlag(KEY, 'u')).toBe(!FLAG_DEFAULTS[KEY]);

    expect(await setFlagOverride(KEY, null)).toEqual({ ok: true }); // clear
    expect(map[KEY]).toBeUndefined();
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]);
  });

  it('clearAllFlagOverrides removes every stored override (the leave-testing reset)', async () => {
    // The "Full testing" / per-flag toggles pin flags on as stored overrides;
    // leaving testing mode must clear them so flags return to bundled defaults
    // (flag-testing-toggle-clears-overrides 2026-06-18).
    const { store, map } = makeFakeStore({ [KEY]: true, [FLAGS.POT_CONTROL]: true });
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, 'u')).toBe(true); // override active (shadows default)

    const cleared = await clearAllFlagOverrides();
    expect([...cleared].sort()).toEqual([FLAGS.POT_CONTROL, KEY].sort());
    expect(map[KEY]).toBeUndefined();
    expect(map[FLAGS.POT_CONTROL]).toBeUndefined();
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]); // back to default
  });

  it('clearAllFlagOverrides with no store configured is a safe no-op', async () => {
    initFlagOverrideStore(null);
    expect(await clearAllFlagOverrides()).toEqual([]);
  });

  it('reads are TTL-cached — repeated getFlag calls do not re-hit the store', async () => {
    const { store, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    await getFlag(KEY, 'u');
    await getFlag(KEY, 'u');
    await getFlag(KEY, 'u');
    expect(loads()).toBe(1);
  });

  it('partitions the read-cache per scope — no cross-workspace bleed', async () => {
    // load() resolves overrides for whatever scope is active at call time
    // (Papercusp: WHERE workspace_id = activeWorkspaceId()). A single global
    // cache would serve the first-loaded scope's overrides to every other
    // scope for the TTL window; cacheKey() partitions the cache so a scope
    // only ever sees its own row.
    let scope = 'ws-a';
    const rows: Record<string, Partial<Record<FlagKey, boolean>>> = {
      'ws-a': { [KEY]: true }, // ws-a overrides KEY ON
      'ws-b': {}, // ws-b has no override → resolves to the default
    };
    const store: FlagOverrideStore = {
      async load() {
        return { ...(rows[scope] ?? {}) };
      },
      async set(key, enabled) {
        rows[scope] ??= {};
        if (enabled === null) delete rows[scope][key];
        else rows[scope][key] = enabled;
      },
      cacheKey: () => scope,
    };
    initFlagOverrideStore(store);

    scope = 'ws-a';
    expect(await getFlag(KEY, 'u')).toBe(true); // ws-a override, now cached

    // Switch scope WITHIN the TTL window — must NOT inherit ws-a's cached value.
    scope = 'ws-b';
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]); // ws-b → default, no bleed

    // ws-a still resolves its own override (its cache entry is independent).
    scope = 'ws-a';
    expect(await getFlag(KEY, 'u')).toBe(true);
  });

  it('getAllFlags overlays stored overrides onto defaults', async () => {
    const { store } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
    initFlagOverrideStore(store);
    const payload = await getAllFlags('u');
    expect(payload.flags[KEY]).toBe(!FLAG_DEFAULTS[KEY]);
    expect(payload.source).toBe('defaults'); // base source unchanged
  });

  it('getAllFlags drops stored keys for RETIRED flags instead of leaking them into the payload', async () => {
    // The PG row outlives flag retirements (e.g. papercusp-oracle folded into
    // papercusp-testing 2026-06-10): a raw spread of the stored map would
    // re-introduce the dead key into every client payload forever.
    const { store } = makeFakeStore({
      [KEY]: true,
      ['papercusp-retired-ghost' as FlagKey]: true,
    });
    initFlagOverrideStore(store);
    const payload = await getAllFlags('u');
    expect(payload.flags[KEY]).toBe(true); // live override still applies
    expect('papercusp-retired-ghost' in payload.flags).toBe(false);
  });

  it('a failing store falls back to defaults instead of throwing', async () => {
    initFlagOverrideStore({
      async load() {
        throw new Error('pg down');
      },
      async set() {
        throw new Error('pg down');
      },
    });
    expect(await getFlag(KEY, 'u')).toBe(FLAG_DEFAULTS[KEY]);
    const r = await setFlagOverride(KEY, true);
    expect(r.ok).toBe(false);
  });
});

/**
 * EI-8867 — the read path must be as honest as the write path.
 *
 * Root cause recap: `setFlagOverride()` reports `override-store-not-configured`, but
 * `loadStoredOverrides()` silently returned `{}` — so a process with no store served
 * FLAG_DEFAULTS while `flags:set` (run in the operator process, which HAS a store) reported
 * success. No single process saw the contradiction. The inference gateway sat in exactly this
 * state and a dark flag "wouldn't turn on" with nothing logged.
 */
describe('EI-8867: missing override store is announced, once', () => {
  // The warn is suppressed under test runners by design, so exercise it the way a real
  // process sees it: with the runner env stubbed off.
  function asRealProcess(fn: () => Promise<void> | void) {
    return async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN', '');
      try {
        await fn();
      } finally {
        vi.unstubAllEnvs();
      }
    };
  }

  beforeEach(() => {
    initFlagOverrideStore(null); // the buggy state: no store
    resetOverrideStoreWarningForTest();
  });
  afterEach(() => {
    initFlagOverrideStore(null);
    vi.restoreAllMocks();
  });

  it('warns exactly ONCE per process even across many getFlag() reads', asRealProcess(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getFlag(KEY, 'u');
    await getFlag(KEY, 'u');
    await getAllFlags('u');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/serving FLAG_DEFAULTS/);
  }));

  it('still fails SOFT — a missing store degrades to defaults, never throws', asRealProcess(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(getFlag(KEY, 'u')).resolves.toBe(FLAG_DEFAULTS[KEY]);
  }));

  it('does NOT warn once a store is installed (the fixed state)', asRealProcess(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initFlagOverrideStore(makeFakeStore({ [KEY]: true }).store);
    expect(await getFlag(KEY, 'u')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  }));

  it('re-arms after a LATE install so an early read never permanently mutes it', asRealProcess(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getFlag(KEY, 'u'); // warns (no store)
    expect(warn).toHaveBeenCalledTimes(1);
    initFlagOverrideStore(makeFakeStore().store); // late install re-arms the latch
    initFlagOverrideStore(null); // ...and the store is torn down again
    await getFlag(KEY, 'u');
    expect(warn).toHaveBeenCalledTimes(2);
  }));

  it('is silent under the env opt-out, and the opt-out does not consume the one shot', asRealProcess(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN', '1');
    await getFlag(KEY, 'u');
    expect(warn).not.toHaveBeenCalled();
    // Un-silence: the latch must NOT have been burned by the suppressed call.
    vi.stubEnv('PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN', '');
    await getFlag(KEY, 'u');
    expect(warn).toHaveBeenCalledTimes(1);
  }));

  it('is silent under a test runner (why this suite stubs the env at all)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getFlag(KEY, 'u');
    expect(warn).not.toHaveBeenCalled();
  });
});
