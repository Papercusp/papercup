import { describe, it, expect } from 'vitest';
import { harnessSchemaName } from './scaffold-harness-schema';

/**
 * Regression (hive-tool-namespace-2026-06-08, live smoke): a raw
 * `DROP SCHEMA harness_<slug>` for a hyphenated slug is BOTH the wrong schema
 * (scaffold sanitizes hyphens→underscores) AND a Postgres syntax error. The
 * scaffold + deprovision paths must share this one name function.
 */
describe('harnessSchemaName', () => {
  it('lowercases and converts hyphens to underscores', () => {
    expect(harnessSchemaName('hive-e2e-smoke-001')).toBe('harness_hive_e2e_smoke_001');
    expect(harnessSchemaName('Abc-Def')).toBe('harness_abc_def');
    expect(harnessSchemaName('plain')).toBe('harness_plain');
  });

  it('produces a name with no characters that break an unquoted DROP SCHEMA', () => {
    const name = harnessSchemaName('a-b-c-1-2-3');
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });
});
