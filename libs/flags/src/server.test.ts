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
      [FLAGS.SNAPSHOTS]: true,
      [FLAGS.ORACLE]: true,
    });
    const payload = await getAllFlags('test-user');
    expect(payload.source).toBe('override');
    expect(payload.flags[FLAGS.SNAPSHOTS]).toBe(true);
    expect(payload.flags[FLAGS.ORACLE]).toBe(true);
    expect(payload.flags[FLAGS.DESIGN]).toBe(false);
  });

  it('null override clears back to defaults', async () => {
    // Use ORACLE (default-false) so clearing the override is observable — the
    // SNAPSHOTS default is now true (revive-cupboard-distribution P1).
    setFlagOverridesForTest({ [FLAGS.ORACLE]: true });
    expect((await getAllFlags('x')).flags[FLAGS.ORACLE]).toBe(true);

    setFlagOverridesForTest(null);
    expect((await getAllFlags('x')).flags[FLAGS.ORACLE]).toBe(FLAG_DEFAULTS[FLAGS.ORACLE]);
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
