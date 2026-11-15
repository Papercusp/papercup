/**
 * Recurrence guard for EI-28824434290519164.
 *
 * `createFreshTestDb` accepts only lowercase generated names. A camel-case prefix
 * such as `createFreshPgDb('hiveFedA')` therefore threw
 * `invalid owned test database name` in a few milliseconds, before any schema
 * setup. That left 15 federation integration suites dead at setup, and CI never
 * ran them, so nothing noticed.
 *
 * This test checks every literal prefix passed to `createFreshPgDb` in the tree
 * against the real owned-name validator after the fold that `createFreshPgDb`
 * applies. A new prefix that the validator would reject fails here, in the unit
 * suite, without needing Postgres.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertOwnedTestDatabaseName } from '@papercusp/test-config/owned-test-db-cleanup';
import { freshPgDbPrefix } from './_pg-helpers';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Shape of the random suffix `createFreshTestDb` appends (6 random bytes, hex). */
const SAMPLE_SUFFIX = '0123456789ab';

/** Every literal `createFreshPgDb('<prefix>')` argument in tracked .ts files. */
function literalPrefixes(): Array<{ file: string; prefix: string }> {
  const files = execFileSync('git', ['grep', '-l', 'createFreshPgDb(', '--', '*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const out: Array<{ file: string; prefix: string }> = [];
  const call = /createFreshPgDb\(\s*(['"`])([^'"`$]*)\1/g;
  for (const file of files) {
    const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(call)) out.push({ file, prefix: m[2] });
  }
  return out;
}

describe('createFreshPgDb prefix folding (EI-28824434290519164)', () => {
  it('folds ASCII upper case so a camel-case tag yields a valid owned name', () => {
    expect(freshPgDbPrefix('hiveFedA')).toBe('hivefeda');
    expect(() => assertOwnedTestDatabaseName(`hiveFedA_${SAMPLE_SUFFIX}`)).toThrow(
      'invalid owned test database name',
    );
    expect(() => assertOwnedTestDatabaseName(`${freshPgDbPrefix('hiveFedA')}_${SAMPLE_SUFFIX}`)).not.toThrow();
  });

  it('does not make an unsafe prefix valid', () => {
    for (const bad of ['../Escape', 'Path/Name', 'Bad"; SELECT 1; --', '', 'A'.repeat(51)]) {
      expect(() => assertOwnedTestDatabaseName(`${freshPgDbPrefix(bad)}_${SAMPLE_SUFFIX}`)).toThrow(
        'invalid owned test database name',
      );
    }
  });

  it('every literal createFreshPgDb prefix in the tree is accepted after folding', () => {
    const found = literalPrefixes();
    // Positive control: the scan must see the call sites that motivated this guard.
    // An empty or tiny result means the scan broke, not that every prefix is valid.
    expect(found.length).toBeGreaterThan(30);
    expect(found.some((f) => f.prefix === 'hiveFedA')).toBe(true);

    const rejected = found.filter(({ prefix }) => {
      try {
        assertOwnedTestDatabaseName(`${freshPgDbPrefix(prefix)}_${SAMPLE_SUFFIX}`);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual([]);
  });
});
