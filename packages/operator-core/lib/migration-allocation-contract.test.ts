/**
 * EI-21114125030406129 — both migration-number allocation doors must share
 * one advisory-lock key. A value-only equality check is insufficient: two
 * duplicated literals can agree today and drift tomorrow, so this contract
 * also proves that both consumers import the zero-dependency canonical module
 * and contain no copy of its literal.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOC_ADVISORY_KEY as canonicalKey,
  scanMigrationDirs,
} from '../../../scripts/lib/migration-allocation.mjs';
import { ALLOC_ADVISORY_KEY as cliKey } from '../../../scripts/next-migration.mjs';
import { ALLOC_ADVISORY_KEY as toolKey } from './agent-tools/db/next_migration';

const cliSource = readFileSync(
  new URL('../../../scripts/next-migration.mjs', import.meta.url),
  'utf8',
);
const toolSource = readFileSync(
  new URL('./agent-tools/db/next_migration.ts', import.meta.url),
  'utf8',
);

describe('migration allocation advisory-lock identity', () => {
  it('both allocation doors consume and re-export the canonical binding', () => {
    expect(cliKey).toBe(canonicalKey);
    expect(toolKey).toBe(canonicalKey);

    expect(cliSource).toContain("from './lib/migration-allocation.mjs'");
    expect(toolSource).toContain(
      "from '../../../../../scripts/lib/migration-allocation.mjs'",
    );
  });

  it('neither consumer hand-keeps the advisory-key literal', () => {
    expect(cliSource).not.toContain('873_135');
    expect(toolSource).not.toContain('873_135');
  });

  /**
   * EI-20300821494280085 — the same drift argument as the lock key, one level
   * out. Both doors used to carry a private `maxNumberOnDisk` reading the sql
   * dirs their own way; they agreed only by coincidence, and the moment either
   * needed a SECOND filesystem fact (is this reservation's file written? is its
   * number taken?) the copies would have diverged on the answer that decides
   * whether a reservation is refused. The scan is shared as CODE now, so this
   * asserts the copies are actually gone rather than merely equivalent.
   */
  it('neither door hand-keeps its own filesystem scan', () => {
    expect(cliSource).toContain('scanMigrationDirs');
    expect(toolSource).toContain('scanMigrationDirs');
    expect(cliSource).not.toContain('readdirSync');
    expect(toolSource).not.toContain('readdirSync');
  });
});

describe('scanMigrationDirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-scan-'));
  const other = mkdtempSync(join(tmpdir(), 'migration-scan-mirror-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  for (const name of [
    '007-armed-migration.sql',
    '008-being-written.sql.DRAFT',
    '009-waiting-on-deploy.sql.PENDING-CODE-DEPLOY',
    'README.md',
    'not-numbered.sql',
  ])
    writeFileSync(join(root, name), '-- fixture\n');
  writeFileSync(join(other, '011-sidecar-mirror.sql'), '-- fixture\n');

  const scan = scanMigrationDirs([root, other, join(root, 'no-such-dir')]);

  it('folds every scanned dir into one max and skips a missing dir instead of throwing', () => {
    // The missing dir is the normal case on a release checkout without the
    // sidecar mirror, and on an uninitialised submodule — refusing to allocate
    // over it would wedge the one chokepoint every migration passes through.
    expect(scan.maxNumber).toBe(11);
    expect([...scan.numbers].sort((a, b) => a - b)).toEqual([7, 8, 9, 11]);
  });

  it('records a runner-hidden file under its ARMED name, so work in flight is not read as unwritten', () => {
    // This is the load-bearing normalisation: the ledger records the eventual
    // `.sql` filename, so a `.DRAFT` matched literally would look absent and
    // the unwritten-reservation rule would refuse an author who is mid-edit —
    // the exact opposite of what it is for.
    expect(scan.filenames.has('008-being-written.sql')).toBe(true);
    expect(scan.filenames.has('009-waiting-on-deploy.sql')).toBe(true);
    expect(scan.filenames.has('007-armed-migration.sql')).toBe(true);
    expect(scan.filenames.has('011-sidecar-mirror.sql')).toBe(true);
  });

  it('ignores files with no leading NNN-', () => {
    expect(scan.filenames.has('README.md')).toBe(false);
    expect(scan.filenames.has('not-numbered.sql')).toBe(false);
  });

  it('returns an empty scan rather than throwing when no dir exists', () => {
    const empty = scanMigrationDirs([join(root, 'nope'), join(other, 'nope')]);
    expect(empty).toEqual({ maxNumber: 0, filenames: new Set(), numbers: new Set() });
  });
});
