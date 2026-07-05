import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAllFlags,
  getFlag,
  initFlagBackend,
  isBackendConfigured,
} from './server';
import { setFlagOverridesForTest } from './test';
import { ALL_FLAG_KEYS, FLAGS, FLAG_DEFAULTS } from './types';

// EI-7686 (watchdog red-test, repeated 4x/6h): `getFlag`/`getAllFlags` deliberately let a
// `PAPERCUSP_FLAG_<KEY>` / `PAPERCUSP_PLATFORM_MODE` env var override the resolved value
// (resolveEnvOverride / resolvePlatformModeOverride in server.ts) — that precedence is
// intentional dev-override behavior, NOT the bug. The actual bug is this file assuming a
// CLEAN env: this dev host's shell exports several ambient overrides for interactive use
// (observed: PAPERCUSP_FLAG_PAPERCUSP_DOGFOOD_PAPERCUSP_HIVE_SHARE=0,
// PAPERCUSP_FLAG_PAPERCUSP_VIDEO_CHANNELS=1, …) that leak into every vitest worker spawned
// from it, so "returns FLAG_DEFAULTS with no backend" silently diverged from the actual
// defaults for any key an ambient var happened to override. Root-caused + fixed as a test-
// isolation bug: snapshot + strip every `PAPERCUSP_FLAG_*` / `PAPERCUSP_PLATFORM_MODE` env
// var before each test in this file (restoring after), so the suite exercises the CODE's
// default behavior regardless of what the invoking shell happens to have exported — the same
// class of ambient-env leak could hit ANY future key, on ANY dev box or CI runner, so this
// guards the whole class rather than special-casing the one key that happened to diverge here.
// NOTE (2026-07-05, su-16455): this exact block was silently dropped from the shared tree once
// already (a concurrent full-file write raced the original landing before git-sync could commit
// it) — if you find this comment missing again, that's the recurrence, not a sign the fix was
// never needed.
function ambientFlagEnvKeys(): string[] {
  return Object.keys(process.env).filter(
    (k) => k.startsWith('PAPERCUSP_FLAG_') || k === 'PAPERCUSP_PLATFORM_MODE',
  );
}
let savedFlagEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedFlagEnv = {};
  for (const k of ambientFlagEnvKeys()) {
    savedFlagEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  // Also strip anything a test set (and forgot to clean up) before restoring the snapshot,
  // so a test's own env mutation never bleeds into the next test.
  for (const k of ambientFlagEnvKeys()) delete process.env[k];
  for (const [k, v] of Object.entries(savedFlagEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
});

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

  it('PAPERCUSP_PLATFORM_MODE=off forces the platform-improvement flag OFF (P-070 release lever)', async () => {
    // Default is ON (dev/self-host). A release build sets PAPERCUSP_PLATFORM_MODE=off.
    expect(FLAG_DEFAULTS[FLAGS.PLATFORM_IMPROVEMENT_LOOPS]).toBe(true);
    process.env.PAPERCUSP_PLATFORM_MODE = 'off';
    try {
      expect(await getFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, 'x')).toBe(false);
      const payload = await getAllFlags('any-distinct');
      expect(payload.flags[FLAGS.PLATFORM_IMPROVEMENT_LOOPS]).toBe(false);
      // It is COARSE — only the platform-improvement flag is affected, nothing else.
      expect(payload.flags[FLAGS.VIDEO_CHANNELS]).toBe(FLAG_DEFAULTS[FLAGS.VIDEO_CHANNELS]);
    } finally {
      delete process.env.PAPERCUSP_PLATFORM_MODE;
    }
  });

  it('PAPERCUSP_PLATFORM_MODE=on (or unset) leaves the platform-improvement flag at its default ON', async () => {
    process.env.PAPERCUSP_PLATFORM_MODE = 'on';
    try {
      expect(await getFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, 'x')).toBe(true);
    } finally {
      delete process.env.PAPERCUSP_PLATFORM_MODE;
    }
    // Unset ⇒ default.
    expect(await getFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, 'x')).toBe(
      FLAG_DEFAULTS[FLAGS.PLATFORM_IMPROVEMENT_LOOPS],
    );
  });

  it('the per-flag PAPERCUSP_FLAG_* override beats PAPERCUSP_PLATFORM_MODE=off (explicit owner opt-in)', async () => {
    process.env.PAPERCUSP_PLATFORM_MODE = 'off';
    process.env.PAPERCUSP_FLAG_PAPERCUSP_PLATFORM_IMPROVEMENT_LOOPS = '1';
    try {
      // Owner opting INTO platform mode on a release build wins over the build-wide off.
      expect(await getFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, 'x')).toBe(true);
      expect((await getAllFlags('x')).flags[FLAGS.PLATFORM_IMPROVEMENT_LOOPS]).toBe(true);
    } finally {
      delete process.env.PAPERCUSP_PLATFORM_MODE;
      delete process.env.PAPERCUSP_FLAG_PAPERCUSP_PLATFORM_IMPROVEMENT_LOOPS;
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
