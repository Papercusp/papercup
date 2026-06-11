import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAllFlags,
  getFlag,
  initFlagBackend,
  isBackendConfigured,
} from './server';
import { setFlagOverridesForTest } from './test';
import { ALL_FLAG_KEYS, FLAGS, FLAG_DEFAULTS } from './types';

describe('flag backend in offline-only mode', () => {
  beforeEach(() => {
    initFlagBackend(null);
    setFlagOverridesForTest(null);
  });
  afterEach(() => {
    setFlagOverridesForTest(null);
  });

  it('returns FLAG_DEFAULTS when no backend is configured (V1 ship-state)', async () => {
    expect(isBackendConfigured()).toBe(false);
    const payload = await getAllFlags('any-distinct');
    expect(payload.source).toBe('defaults');
    for (const key of ALL_FLAG_KEYS) {
      expect(payload.flags[key]).toBe(FLAG_DEFAULTS[key]);
    }
  });

  it('getFlag returns the default boolean per key', async () => {
    for (const key of ALL_FLAG_KEYS) {
      const v = await getFlag(key, 'any-distinct');
      expect(v).toBe(FLAG_DEFAULTS[key]);
    }
  });

  it('PAPERCUSP_FLAG_<KEY> env override is reflected in getAllFlags (not just getFlag)', async () => {
    const envKey = 'PAPERCUSP_FLAG_PAPERCUSP_VIDEO_CHANNELS';
    process.env[envKey] = '1';
    try {
      expect(await getFlag(FLAGS.VIDEO_CHANNELS, 'x')).toBe(true);
      const payload = await getAllFlags('any-distinct');
      expect(payload.flags[FLAGS.VIDEO_CHANNELS]).toBe(true); // env beats defaults
      expect(payload.flags[FLAGS.TESTING]).toBe(FLAG_DEFAULTS[FLAGS.TESTING]); // others untouched
      // env override also beats in-process test overrides (same precedence as getFlag)
      const allOff = Object.fromEntries(ALL_FLAG_KEYS.map((k) => [k, false]));
      setFlagOverridesForTest(allOff as Record<(typeof ALL_FLAG_KEYS)[number], boolean>);
      const overridden = await getAllFlags('any-distinct');
      expect(overridden.flags[FLAGS.VIDEO_CHANNELS]).toBe(true);
    } finally {
      delete process.env[envKey];
      setFlagOverridesForTest(null);
    }
  });

  it('FLAG_DEFAULTS contains every FLAGS key (no drift)', () => {
    for (const key of Object.values(FLAGS)) {
      expect(FLAG_DEFAULTS).toHaveProperty(key);
      expect(typeof FLAG_DEFAULTS[key]).toBe('boolean');
    }
    expect(Object.keys(FLAG_DEFAULTS).length).toBe(Object.keys(FLAGS).length);
  });
});

describe('setFlagOverridesForTest', () => {
  beforeEach(() => {
    initFlagBackend(null);
  });
  afterEach(() => {
    setFlagOverridesForTest(null);
  });

  it('overrides resolve to the supplied values, defaults fill the rest', async () => {
    setFlagOverridesForTest({
      [FLAGS.HARNESS_PHASES]: true,
      [FLAGS.TESTING]: true,
    });
    const payload = await getAllFlags('test-user');
    expect(payload.source).toBe('override');
    expect(payload.flags[FLAGS.HARNESS_PHASES]).toBe(true);
    expect(payload.flags[FLAGS.TESTING]).toBe(true);
    expect(payload.flags[FLAGS.DESIGN]).toBe(false);
  });

  it('null override clears back to defaults', async () => {
    // Use TESTING (default-false) so clearing the override is observable.
    setFlagOverridesForTest({ [FLAGS.TESTING]: true });
    expect((await getAllFlags('x')).flags[FLAGS.TESTING]).toBe(true);

    setFlagOverridesForTest(null);
    expect((await getAllFlags('x')).flags[FLAGS.TESTING]).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
    expect((await getAllFlags('x')).source).toBe('defaults');
  });

  it('partial overrides do not affect un-listed flags', async () => {
    setFlagOverridesForTest({ [FLAGS.DESIGN]: true });
    const payload = await getAllFlags('x');
    expect(payload.flags[FLAGS.DESIGN]).toBe(true);
    for (const key of ALL_FLAG_KEYS) {
      if (key === FLAGS.DESIGN) continue;
      expect(payload.flags[key]).toBe(FLAG_DEFAULTS[key]);
    }
  });
});
