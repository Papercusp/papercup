import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidateSqlDirs } from './next_migration';

const ENV_KEYS = [
  'PAPERCUSP_PG_SQL_DIR',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_CANONICAL_TREE',
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('db:next-migration path discovery', () => {
  it('scans the canonical edit tree alongside the serving and integration mirror trees', () => {
    const servingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'next-migration-serving-'));
    const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'next-migration-integration-'));
    const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'next-migration-canonical-'));
    tempRoots.push(servingRoot, integrationRoot, canonicalRoot);
    const servingSqlDir = path.join(servingRoot, 'sql');
    const integrationSqlDir = path.join(integrationRoot, 'libs/papercusp/libs/db/sql');
    const canonicalSqlDir = path.join(canonicalRoot, 'libs/papercusp/libs/db/sql');
    fs.mkdirSync(servingSqlDir);
    fs.mkdirSync(integrationSqlDir, { recursive: true });
    fs.mkdirSync(canonicalSqlDir, { recursive: true });
    process.env.PAPERCUSP_PG_SQL_DIR = servingSqlDir;
    process.env.PAPERCUSP_INTEGRATION_ROOT = integrationRoot;
    process.env.PAPERCUSP_CANONICAL_TREE = canonicalRoot;

    expect(candidateSqlDirs()).toEqual([servingSqlDir, integrationSqlDir, canonicalSqlDir]);
  });
});
