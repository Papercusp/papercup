/**
 * types.test.ts — the flag registry invariants + `resolveWithDefaults`, the
 * single helper every read path (client + server) funnels through so a partial
 * payload never drops a flag. Pure unit, no env/network.
 *
 * Why this matters: a flag string typo or a missing FLAG_DEFAULTS entry would
 * desync PostHog (keyed by the exact string) from the bundled fallback, and the
 * gate would silently read the wrong default. These assertions pin the drift.
 */
import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  FLAG_DEFAULTS,
  ALL_FLAG_KEYS,
  resolveWithDefaults,
  type FlagKey,
} from './types';

describe('flag registry invariants', () => {
  it('ALL_FLAG_KEYS is exactly the FLAGS string values (no drift)', () => {
    expect([...ALL_FLAG_KEYS].sort()).toEqual([...Object.values(FLAGS)].sort());
  });

  it('every flag string value is unique', () => {
    const vals = Object.values(FLAGS);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('every flag key uses the canonical `papercusp-` prefix', () => {
    for (const key of ALL_FLAG_KEYS) {
      expect(key.startsWith('papercusp-')).toBe(true);
    }
  });

  it('FLAG_DEFAULTS has a boolean for exactly the FLAGS keys', () => {
    expect(Object.keys(FLAG_DEFAULTS).sort()).toEqual([...ALL_FLAG_KEYS].sort());
    for (const key of ALL_FLAG_KEYS) {
      expect(typeof FLAG_DEFAULTS[key]).toBe('boolean');
    }
  });

  it('V1 ship-state defaults: every flag is OFF (snapshots retired — retire-snapshots-instance-spec)', () => {
    for (const key of ALL_FLAG_KEYS) {
      expect(FLAG_DEFAULTS[key]).toBe(false);
    }
  });
});

describe('resolveWithDefaults', () => {
  it('with an empty partial, returns a full copy of FLAG_DEFAULTS', () => {
    const out = resolveWithDefaults({});
    expect(out).toEqual(FLAG_DEFAULTS);
    // a fresh object, not the shared const
    expect(out).not.toBe(FLAG_DEFAULTS);
  });

  it('applies supplied boolean overrides over the defaults', () => {
    const out = resolveWithDefaults({ [FLAGS.ORACLE]: true });
    expect(out[FLAGS.ORACLE]).toBe(true);
    expect(out[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
  });

  it('honours an explicit false override (not treated as "unset")', () => {
    // An explicit `false` must be applied (the guard keys off `typeof === boolean`,
    // not truthiness) — distinct from an absent key, which keeps the default.
    const out = resolveWithDefaults({ [FLAGS.ORACLE]: false });
    expect(out[FLAGS.ORACLE]).toBe(false);
  });

  it('ignores non-boolean values (undefined / null / string) and keeps the default', () => {
    const partial = {
      [FLAGS.ORACLE]: undefined,
      [FLAGS.DESIGN]: null as unknown as boolean,
      [FLAGS.TESTING]: 'yes' as unknown as boolean,
    };
    const out = resolveWithDefaults(partial);
    expect(out[FLAGS.ORACLE]).toBe(FLAG_DEFAULTS[FLAGS.ORACLE]);
    expect(out[FLAGS.DESIGN]).toBe(FLAG_DEFAULTS[FLAGS.DESIGN]);
    expect(out[FLAGS.TESTING]).toBe(FLAG_DEFAULTS[FLAGS.TESTING]);
  });

  it('ignores unknown keys not in ALL_FLAG_KEYS', () => {
    const out = resolveWithDefaults({
      'papercusp-not-a-real-flag': true,
    } as Partial<Record<FlagKey, boolean>>);
    expect(out).toEqual(FLAG_DEFAULTS);
    expect((out as Record<string, boolean>)['papercusp-not-a-real-flag']).toBeUndefined();
  });

  it('does not mutate FLAG_DEFAULTS', () => {
    const before = { ...FLAG_DEFAULTS };
    resolveWithDefaults({ [FLAGS.ORACLE]: true, [FLAGS.DESIGN]: false });
    expect(FLAG_DEFAULTS).toEqual(before);
  });

  it('always resolves to the full key set, whatever the partial', () => {
    const out = resolveWithDefaults({ [FLAGS.ORACLE]: true });
    expect(Object.keys(out).sort()).toEqual([...ALL_FLAG_KEYS].sort());
  });
});
