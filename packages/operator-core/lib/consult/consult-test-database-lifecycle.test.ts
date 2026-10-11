import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const consultDir = fileURLToPath(new URL('.', import.meta.url));
const integrationSources = readdirSync(consultDir)
  .filter((name) => name.endsWith('.integration.test.ts'))
  .map((name) => ({ name, source: readFileSync(join(consultDir, name), 'utf8') }));

describe('consult PostgreSQL fixture ownership', () => {
  it('keeps per-run databases under the owned fixture helper', () => {
    const manualDatabaseOwners = integrationSources
      .filter(({ source }) => /\bCREATE\s+DATABASE\b|\bgetTestPg\s*\(|\bmarkManagedTestDatabase\s*\(/i.test(source))
      .map(({ name }) => name);

    expect(manualDatabaseOwners).toEqual([]);
  });

  it('drops every owned fresh database after its client closes', () => {
    const freshDatabaseOwners = integrationSources
      .filter(({ source }) => /\bcreateFreshTestDb\s*\(/.test(source));
    const missingDrop = freshDatabaseOwners
      .filter(({ source }) => !/afterAll\s*\([\s\S]*?\b(?:fixtureDb|db)\?\.drop\s*\(/.test(source))
      .map(({ name }) => name);

    expect(freshDatabaseOwners.length).toBeGreaterThan(0);
    expect(missingDrop).toEqual([]);
  });
});
