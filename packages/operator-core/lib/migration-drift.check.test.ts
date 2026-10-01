/**
 * WI-10002541: `checkMigrationDrift` must not read and sha256 every applied
 * migration unless the caller asks for content drift. Boot and system-health
 * call it on every tick and read only `schemaAhead` / `missing`; on the rig VM
 * the unconditional re-hash was a ~150ms synchronous main-thread block per
 * call. This pins the READ COUNT (not just the result shape), with no PG: the
 * org pool is mocked and `readFileSync` is wrapped to count reads under the
 * fixture migrations dir.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appliedRows: Array<{ filename: string; sha256: string | null }> = [];

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([...appliedRows]);
    return { sql: Object.assign(sql, { begin: vi.fn() }) };
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const fs = await import('node:fs');
const { checkMigrationDrift } = await import('./migration-drift');

const ENV_KEYS = [
  'PAPERCUSP_PG_SQL_DIR',
  'PAPERCUSP_CANONICAL_TREE',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_RELEASE_ROOT',
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = '';
let sqlDir = '';

function readsUnderSqlDir(): number {
  const calls = vi.mocked(fs.readFileSync).mock.calls;
  return calls.filter(([p]) => typeof p === 'string' && p.startsWith(sqlDir + path.sep)).length;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wi10002541-drift-'));
  sqlDir = path.join(root, 'sql');
  fs.mkdirSync(sqlDir);
  const files: Record<string, string> = {
    '001-a.sql': 'CREATE TABLE a (id int);\n',
    '002-b.sql': 'CREATE TABLE b (id int);\n',
    '003-c.sql': 'CREATE TABLE c (id int);\n',
  };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(sqlDir, f), text);
  appliedRows.splice(0, appliedRows.length,
    { filename: '001-a.sql', sha256: createHash('sha256').update(files['001-a.sql']).digest('hex') },
    // Recorded hash differs from disk: edited after it was applied.
    { filename: '002-b.sql', sha256: 'recorded-before-an-edit' },
    { filename: '003-c.sql', sha256: createHash('sha256').update(files['003-c.sql']).digest('hex') },
  );
  process.env.PAPERCUSP_PG_SQL_DIR = sqlDir;
  delete process.env.PAPERCUSP_CANONICAL_TREE;
  delete process.env.PAPERCUSP_INTEGRATION_ROOT; // canonical tree unresolved -> compare sqlDir
  process.env.PAPERCUSP_RELEASE_ROOT = path.join(root, 'no-release-tree');
  vi.mocked(fs.readFileSync).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkMigrationDrift content hashing is opt-in (WI-10002541)', () => {
  it('the default call reads no migration file and reports content drift as NOT MEASURED', async () => {
    const d = await checkMigrationDrift();
    expect(readsUnderSqlDir()).toBe(0);
    expect(d.contentDrift).toBeNull();
    expect(d.contentDriftExecutable).toBeNull();
    // WI-10004651: unmeasured stays unmeasured — never an empty "nothing new".
    expect(d.contentDriftNew).toBeNull();
    // What the default callers DO read is still computed.
    expect(d.sqlDir).toBe(sqlDir);
    expect(d.missing).toEqual([]);
    expect(d.inSync).toBe(true);
  });

  it('checkContent:true reads each applied migration once and finds the edited one', async () => {
    const d = await checkMigrationDrift({ checkContent: true });
    expect(readsUnderSqlDir()).toBe(3);
    expect(d.contentDrift?.map((e) => [e.filename, e.classification])).toEqual([['002-b.sql', 'unclassified']]);
    // Unclassified counts as hazardous.
    expect(d.contentDriftExecutable?.map((e) => e.filename)).toEqual(['002-b.sql']);
    // WI-10004651: 002-b.sql is not in the acknowledged set, so it is NEW drift —
    // the field the improvements watchdog alerts on.
    expect(d.contentDriftNew?.map((e) => e.filename)).toEqual(['002-b.sql']);
  });

  it('classifyContent:true implies checkContent', async () => {
    const d = await checkMigrationDrift({ classifyContent: true });
    expect(readsUnderSqlDir()).toBeGreaterThanOrEqual(3);
    expect(d.contentDrift?.map((e) => e.filename)).toEqual(['002-b.sql']);
  });
});
