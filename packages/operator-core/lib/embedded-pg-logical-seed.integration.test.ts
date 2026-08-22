/**
 * WI-39304 recurrence guard.
 *
 * One logical seed is built from the real migration set, then restored into TWO
 * independent fresh embedded-Postgres data directories. The test proves both
 * sides of the contract that a schema-only check misses:
 *   - restore really took the logical fast path and produced the full migrated schema;
 *   - each install kept the distinct system_identifier assigned by its own initdb.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import {
  defaultSkipFile,
  startEmbeddedPostgresServer,
} from '@papercusp/embedded-postgres-server';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SQL_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const BUILD_SEED = join(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs',
);
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('free-port probe returned no TCP address'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

describe('logical embedded-PG seed preserves per-install cluster identity', () => {
  it('restores one dump twice with distinct system identifiers and the full migration ledger', async () => {
    const work = await tempDir('papercusp-logical-seed-');
    const seedPath = join(work, 'db-seed.dump');
    const buildPort = await freePort();
    const pgDumpBin = process.env.PAPERCUSP_PG_DUMP_BIN ?? 'pg_dump';
    const pgRestoreBin = process.env.PAPERCUSP_PG_RESTORE_BIN ?? 'pg_restore';

    await execFileAsync(
      process.execPath,
      [
        BUILD_SEED,
        '--data', join(work, 'builder-pgdata'),
        '--sql', SQL_DIR,
        '--out', seedPath,
        '--port', String(buildPort),
        '--pg-dump', pgDumpBin,
      ],
      {
        cwd: REPO_ROOT,
        timeout: 300_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );

    const seedFile = await open(seedPath, 'r');
    const magic = Buffer.alloc(5);
    try {
      await seedFile.read(magic, 0, magic.length, 0);
    } finally {
      await seedFile.close();
    }
    expect(magic.toString('ascii')).toBe('PGDMP');

    const expectedMigrations = (await readdir(SQL_DIR))
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !defaultSkipFile(file))
      .length;
    expect(expectedMigrations).toBeGreaterThan(500);

    const originalDisableSeed = process.env.PAPERCUSP_PG_DISABLE_SEED;
    process.env.PAPERCUSP_PG_DISABLE_SEED = '';
    try {
      const bootInstall = async (label: string) => {
        const dataDir = await tempDir(`papercusp-logical-seed-${label}-`);
        const port = await freePort();
        const logs: string[] = [];
        let handle: Awaited<ReturnType<typeof startEmbeddedPostgresServer>> | undefined;
        try {
          handle = await startEmbeddedPostgresServer({
            dataDir,
            port,
            dbSqlDir: SQL_DIR,
            seedPath,
            pgRestoreBin,
            onLog: (message) => logs.push(message),
          });
          const sql = postgres(handle.urls.admin, { max: 1, onnotice: () => {} });
          try {
            const [row] = await sql.unsafe(`
              SELECT
                (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
                (SELECT count(*)::int FROM harness_shared.schema_migrations) AS migrations
            `);
            expect(logs.some((line) => line.includes('logical seed restored'))).toBe(true);
            expect(logs.some((line) => line.includes('logical seed failed'))).toBe(false);
            return {
              systemIdentifier: String(row.system_identifier),
              migrations: Number(row.migrations),
            };
          } finally {
            await sql.end({ timeout: 5 }).catch(() => {});
          }
        } finally {
          await handle?.stop().catch(() => {});
        }
      };

      const first = await bootInstall('one');
      const second = await bootInstall('two');

      expect(first.migrations).toBe(expectedMigrations);
      expect(second.migrations).toBe(expectedMigrations);
      expect(first.systemIdentifier).not.toBe(second.systemIdentifier);
    } finally {
      if (originalDisableSeed === undefined) delete process.env.PAPERCUSP_PG_DISABLE_SEED;
      else process.env.PAPERCUSP_PG_DISABLE_SEED = originalDisableSeed;
    }
  }, 600_000);
});
