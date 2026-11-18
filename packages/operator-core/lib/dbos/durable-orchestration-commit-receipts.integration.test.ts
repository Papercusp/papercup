// @vitest-environment node
/** Measurement fixture controls, not GEC journey or serving acceptance. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase, teardownTestPg } from '@papercusp/test-config/pg';
import { reviewedDurableServerValues } from '../../test/_durable-orchestration-capture';

const marker = 'b'.repeat(64), payload = 'original λ.😺';
const input = {
  systemDatabase: 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b',
  serverMessageSourceRef: 'source:pg/lib/client.js@4d8f863700d5a94c443edf9186f546c555486a66d0575806a2fe792c43911a46#NoticeResponse+ReadyForQuery',
  marker, catalogSourceRef: 'test:complete-synthetic-column-census',
  columns: { workflow_status: ['value', 'nullable'], operation_outputs: ['value', 'nullable'],
    application_versions: ['value', 'nullable'] },
};
const fixture = reviewedDurableServerValues({ ...input, retainCommittedRows: true })!;
const statement = 'INSERT INTO dbos.application_versions (value, nullable) VALUES ($1, $2)';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let adminUri: string, database: string, dsn: string, sql: postgres.Sql;
let directory: string;
function retain(name: string, value: unknown) {
  const destination = process.env.PAPERCUSP_TEST_ARTIFACT_DIR ?? directory;
  writeFileSync(join(destination, 'gec-commit-receipts-' + name + '.json'), JSON.stringify({
    kind: 'independent-server-value-control', acceptance: 'unmeasured', input,
    fixture, ...value as Record<string, unknown>,
  }), { flag: 'wx', mode: 0o600 });
}

beforeAll(async () => {
  adminUri = await getTestPg();
  database = 'gec_commit_receipts_' + randomBytes(5).toString('hex');
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe('CREATE DATABASE "' + database + '"');
    await markManagedTestDatabase(admin, database);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(adminUri); url.pathname = '/' + database; dsn = url.toString();
  sql = postgres(dsn, { max: 2, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA dbos');
  for (const table of Object.keys(input.columns))
    await sql.unsafe('CREATE TABLE dbos.' + table + ' (value text, nullable text)');
  for (const ddl of fixture.ddl) await sql.unsafe(ddl);
  directory = mkdtempSync(join(tmpdir(), 'gec-commit-receipts-'));
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (adminUri && database) {
    const admin = postgres(adminUri, { max: 1 });
    try { await admin.unsafe('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)'); }
    finally { await admin.end({ timeout: 5 }); }
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('independent committed server-value receipts', () => {
  it('leaves the existing notice-only fixture unchanged unless explicitly enrolled', () => {
    const original = reviewedDurableServerValues(input)!;
    expect(original.committedRows).toBeNull();
    expect(original.ddl.join('\n')).not.toContain('gec_committed_server_values');
    expect(fixture.committedRows).toMatchObject({ accountingScope: 'committed-server-values-only',
      acceptance: 'unmeasured', missingReceipt: 'unknown', marker });
  });

  it.each(['committed', 'uncommitted'])('retains only %s row values after an actual child SIGKILL', async mode => {
    await sql.unsafe('TRUNCATE dbos.application_versions, dbos.gec_committed_server_values');
    const childPath = join(directory, mode + '.mts');
    // An ESM file survives the maintained committed-source loader. No eval/CJS
    // fallback and no server credentials in the retained child's output.
    writeFileSync(childPath, `
      const { default: postgres } = await import(process.env.GEC_POSTGRES_MODULE);
      const sql = postgres(process.env.GEC_COMMIT_DSN, { max: 1, onnotice: () => {} });
      const write = async tx => {
        await tx.unsafe(process.env.GEC_STATEMENT, [process.env.GEC_PAYLOAD, null]);
        process.stdout.write('write-returned');
        if (process.env.GEC_MODE === 'uncommitted') process.kill(process.pid, 'SIGKILL');
      };
      if (process.env.GEC_MODE === 'uncommitted') await sql.begin(write);
      else { await write(sql); process.kill(process.pid, 'SIGKILL'); }
    `);
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', childPath], {
      timeout: 20_000, encoding: 'utf8', env: { ...process.env,
        GEC_COMMIT_DSN: dsn, GEC_POSTGRES_MODULE: pathToFileURL(createRequire(import.meta.url).resolve('postgres')).href,
        GEC_STATEMENT: statement, GEC_PAYLOAD: payload, GEC_MODE: mode },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBe('SIGKILL');
    expect(child.status).toBeNull();
    expect(child.stdout).toBe('write-returned');
    const receipts = await sql.unsafe(fixture.committedRows!.query, [marker]);
    const rows = await sql.unsafe('SELECT value, nullable FROM dbos.application_versions');
    retain(mode, { mode, statement, payload, receipts: [...receipts], rows: [...rows],
      process: { pid: child.pid, status: child.status, signal: child.signal, stdout: child.stdout,
        stderr: child.stderr, error: child.error?.message ?? null } });
    expect(receipts).toHaveLength(mode === 'committed' ? 1 : 0);
    expect(rows).toHaveLength(mode === 'committed' ? 1 : 0);
    if (mode === 'committed') {
      const receipt = receipts[0]!.receipt;
      expect(receipt).toMatchObject({ marker, schema: 'dbos', table: 'application_versions',
        operation: 'INSERT', queryHash: digest(statement), values: [
          { column: 'value', hex: Buffer.from(payload).toString('hex'), changed: true },
          { column: 'nullable', hex: null, changed: true },
        ] });
      expect(receipt.backend).toBeGreaterThan(0);
      expect(receipt.transactionId).toMatch(/^[1-9][0-9]*$/);
      const [reader] = await sql.unsafe('SELECT pg_backend_pid() AS pid');
      expect(receipt.backend).not.toBe(reader!.pid);
      expect(await sql.unsafe(fixture.committedRows!.query, ['c'.repeat(64)])).toHaveLength(0);
    }
  });

  it('requires cross-connection commit visibility and preserves changed versus unchanged values', async () => {
    await sql.unsafe('TRUNCATE dbos.application_versions, dbos.gec_committed_server_values');
    const writer = await sql.reserve();
    try {
      await writer.unsafe('BEGIN');
      await writer.unsafe(statement, [payload, null]);
      const beforeCommit = [...await sql.unsafe(fixture.committedRows!.query, [marker])];
      expect(beforeCommit).toHaveLength(0);
      await writer.unsafe('COMMIT');
      await writer.unsafe('UPDATE dbos.application_versions SET value = $1', [payload]);
      await writer.unsafe('UPDATE dbos.application_versions SET value = $1', ['new λ']);
      const receipts = await sql.unsafe(fixture.committedRows!.query, [marker]);
      retain('visibility', { statement, payload, beforeCommit, receipts: [...receipts] });
      expect(receipts).toHaveLength(3);
      expect(receipts.map(row => row.receipt.values[0].changed)).toEqual([true, false, true]);
      expect(receipts[2]!.receipt.values[0].hex).toBe(Buffer.from('new λ').toString('hex'));
    } finally { await writer.unsafe('ROLLBACK'); writer.release(); }
  });
});
