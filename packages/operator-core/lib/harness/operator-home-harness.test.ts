import { describe, it, expect, afterEach } from 'vitest';
import { operatorHomeHarnessSlug, LEGACY_DEFAULT_HOME_HARNESS, HOME_HARNESS_ENV } from './operator-home-harness';

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
