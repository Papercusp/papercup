/**
 * Persistent runtime-override layer (audit P-070, EI-76).
 *
 * Precedence under test: env var > test overrides > stored override >
 * PostHog/defaults. The store is injected (Papercusp wires a PG-backed one
 * in operator-core's flag-bus); here a fake in-memory store stands in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAllFlags,
  getFlag,
  initFlagBackend,
  initFlagOverrideStore,
  isOverrideStoreConfigured,
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

  it('reads are TTL-cached — repeated getFlag calls do not re-hit the store', async () => {
    const { store, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    await getFlag(KEY, 'u');
    await getFlag(KEY, 'u');
    await getFlag(KEY, 'u');
    expect(loads()).toBe(1);
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
