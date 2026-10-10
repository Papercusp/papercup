import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixtureSource = readFileSync(new URL('../test/_org-test-db.ts', import.meta.url), 'utf8');

describe('apps/operator org test database lifecycle', () => {
  it('uses the managed test-config lifecycle for creation and cleanup', () => {
    expect(fixtureSource).toContain("createFreshTestDb({ prefix: 'org' })");
    expect(fixtureSource).toContain('await db.drop()');
    expect(fixtureSource).not.toMatch(/\bCREATE DATABASE\b/i);
    expect(fixtureSource).not.toMatch(/\bDROP DATABASE\b/i);
  });
});
