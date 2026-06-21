import { describe, it, expect, afterEach } from 'vitest';
import {
  operatorHomeHarnessSlug,
  LEGACY_DEFAULT_HOME_HARNESS,
  HOME_HARNESS_ENV,
  canonicalHarnessSlug,
  RETIRED_HARNESS_SLUG_ALIASES,
} from './operator-home-harness';

describe('operatorHomeHarnessSlug — single home-harness pointer (papercup→papercusp generalization)', () => {
  const orig = process.env[HOME_HARNESS_ENV];
  afterEach(() => { if (orig === undefined) delete process.env[HOME_HARNESS_ENV]; else process.env[HOME_HARNESS_ENV] = orig; });

  it('returns the pointer when set (any hive can be home)', () => {
    process.env[HOME_HARNESS_ENV] = 'papercusp';
    expect(operatorHomeHarnessSlug()).toBe('papercusp');
  });
  it('falls back to the legacy default when unset (behavior-preserving)', () => {
    delete process.env[HOME_HARNESS_ENV];
    expect(operatorHomeHarnessSlug()).toBe(LEGACY_DEFAULT_HOME_HARNESS);
    expect(LEGACY_DEFAULT_HOME_HARNESS).toBe('papercusp');
  });
  it('trims + ignores empty pointer', () => {
    process.env[HOME_HARNESS_ENV] = '   ';
    expect(operatorHomeHarnessSlug()).toBe(LEGACY_DEFAULT_HOME_HARNESS);
    process.env[HOME_HARNESS_ENV] = '  acme-hive  ';
    expect(operatorHomeHarnessSlug()).toBe('acme-hive');
  });
});

describe('canonicalHarnessSlug — retired-slug rename-compat shim (EI-2224)', () => {
  it('maps the retired `papercup` slug to the registered `papercusp`', () => {
    // The exact rename that darkened the dispatcher ~34h: a lingering `papercup`
    // reference must self-heal to the current `papercusp` registration.
    expect(canonicalHarnessSlug('papercup')).toBe('papercusp');
    expect(RETIRED_HARNESS_SLUG_ALIASES.papercup).toBe('papercusp');
  });
  it('leaves an unknown / current slug unchanged (not an arbitrary normalizer)', () => {
    expect(canonicalHarnessSlug('papercusp')).toBe('papercusp');
    expect(canonicalHarnessSlug('acme-hive')).toBe('acme-hive');
  });
  it('trims surrounding whitespace before matching', () => {
    expect(canonicalHarnessSlug('  papercup  ')).toBe('papercusp');
  });
  it('passes empty/whitespace through unchanged', () => {
    expect(canonicalHarnessSlug('')).toBe('');
    expect(canonicalHarnessSlug('   ')).toBe('   ');
  });
  it('the alias map is frozen (a const rename table, not mutable state)', () => {
    expect(Object.isFrozen(RETIRED_HARNESS_SLUG_ALIASES)).toBe(true);
  });
});
