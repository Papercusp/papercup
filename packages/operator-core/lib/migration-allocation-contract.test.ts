/**
 * EI-21114125030406129 — both migration-number allocation doors must share
 * one advisory-lock key. A value-only equality check is insufficient: two
 * duplicated literals can agree today and drift tomorrow, so this contract
 * also proves that both consumers import the zero-dependency canonical module
 * and contain no copy of its literal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALLOC_ADVISORY_KEY as canonicalKey } from '../../../scripts/lib/migration-allocation.mjs';
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
});
