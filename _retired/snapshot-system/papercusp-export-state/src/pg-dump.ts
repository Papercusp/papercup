/**
 * Postgres capture for snapshots — §15.5 steps 3 + 4.
 *
 *   1. pg_dump --schema=harness_<slug>          → state/db.sql.gz
 *   2. pg_dump --schema=harness_shared --schema-only → state/shared-schema.sql
 *   3. For each included shared table, dump filtered rows to CSV
 *      (PG's canonical FORMAT csv, HEADER) → state/shared-<table>.csv
 *
 * Dispatch:
 *   - Steps 1+2 shell out to the system `pg_dump` binary.
 *   - Filtered shared-row CSVs (step 3) use postgres-js `COPY ... TO STDOUT`,
 *     which needs no binary.
 *
 * Connection URL defaults to `HARNESS_ADMIN_DATABASE_URL` (admin role; needed
 * to dump full DDL + cross-schema reads). Caller can override via
 * `CaptureRequest.databaseUrl`.
 */

import { spawn } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { assertValidSlug, includedSharedTables } from './shared-table-filters';

const ADMIN_URL_ENV = 'HARNESS_ADMIN_DATABASE_URL';
const APP_URL_ENV = 'HARNESS_DATABASE_URL';

export function resolveDatabaseUrl(override?: string): string {
  if (override) return override;
  const admin = process.env[ADMIN_URL_ENV];
  if (admin) return admin;
  const app = process.env[APP_URL_ENV];
  if (app) return app;
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runStream(
  cmd: string,
  args: string[],
  destPath: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = createWriteStream(destPath);
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => reject(e));
    out.on('error', (e) => reject(e));
    child.on('close', (code) => {
      out.end(() => resolve({ code: code ?? -1, stdout: '', stderr }));
    });
  });
}

async function pgDumpViaSystemBinary(args: string[], outPath: string): Promise<void> {
  const r = await runStream('pg_dump', args, outPath);
  if (r.code !== 0) {
    throw new Error(`pg_dump failed (code ${r.code}): ${r.stderr.trim()}`);
  }
}

export async function pgDumpPerHarness(args: {
  slug: string;
  destDir: string;
  databaseUrl?: string;
}): Promise<{ outPath: string }> {
  assertValidSlug(args.slug);
  const url = resolveDatabaseUrl(args.databaseUrl);
  const outPath = join(args.destDir, 'db.sql.gz');
  await pgDumpViaSystemBinary(
    [
      `--schema=harness_${args.slug}`,
      '--no-owner',
      '--no-privileges',
      // postgres-js (which the restore-side uses for client.unsafe())
      // doesn't speak `COPY ... FROM stdin` followed by `\.` — it
      // tokenizes the `\.` as a syntax error. Emit INSERTs instead so
      // every statement is valid SQL.
      '--inserts',
      '--compress=4',
      url,
    ],
    outPath,
  );
  return { outPath };
}

export async function pgDumpSharedSchema(args: {
  destDir: string;
  databaseUrl?: string;
}): Promise<{ outPath: string }> {
  const url = resolveDatabaseUrl(args.databaseUrl);
  const outPath = join(args.destDir, 'shared-schema.sql');
  await pgDumpViaSystemBinary(
    ['--schema-only', '--schema=harness_shared', '--no-owner', '--no-privileges', url],
    outPath,
  );
  return { outPath };
}

/**
 * Filtered CSV dump for each shared table via postgres-js's COPY TO STDOUT
 * (no binary needed). Output format matches the prior
 * `psql -c "\COPY (...) TO STDOUT WITH (FORMAT csv, HEADER)"` byte-for-byte.
 */
export async function copyFilteredSharedTables(args: {
  slug: string;
  destDir: string;
  databaseUrl?: string;
}): Promise<{ written: { table: string; outPath: string; rowCount: number }[] }> {
  assertValidSlug(args.slug);
  const url = resolveDatabaseUrl(args.databaseUrl);
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  const written: { table: string; outPath: string; rowCount: number }[] = [];
  try {
    for (const entry of includedSharedTables()) {
      // Skip include tables not present on this DB — e.g. a table whose migration
      // hasn't landed yet (work_items, distribution P-005, lands as
      // harness_shared.work_items). Without this the COPY below throws and aborts
      // the entire capture; an absent table is a recorded no-op, not a hard fail.
      const reg = await sql`SELECT to_regclass(${`harness_shared.${entry.table}`}) AS oid`;
      if (!reg[0]?.oid) {
        // eslint-disable-next-line no-console
        console.warn(`[snapshot] skipping shared table harness_shared.${entry.table}: not present on this DB`);
        continue;
      }
      const where = entry.filter(args.slug);
      const outPath = join(args.destDir, `shared-${entry.table}.csv`);
      const copySql = `COPY (SELECT * FROM harness_shared.${entry.table} WHERE ${where}) TO STDOUT WITH (FORMAT csv, HEADER)`;
      const rs = await sql.unsafe(copySql).readable();
      const ws = createWriteStream(outPath);
      await pipeline(rs, ws);
      const stat = await fs.stat(outPath);
      let rowCount = 0;
      if (stat.size > 0) {
        const txt = await fs.readFile(outPath, 'utf8');
        rowCount = Math.max(0, txt.split('\n').filter((l) => l.length > 0).length - 1);
      }
      written.push({ table: entry.table, outPath, rowCount });
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  return { written };
}

/**
 * Runs the four-step DB capture against `<staging>/state/`.
 */
export async function dbCapture(args: {
  slug: string;
  stateDir: string;
  databaseUrl?: string;
}): Promise<{
  perHarness: { outPath: string };
  sharedSchema: { outPath: string };
  sharedTables: { written: { table: string; outPath: string; rowCount: number }[] };
}> {
  await fs.mkdir(args.stateDir, { recursive: true });
  const perHarness = await pgDumpPerHarness({
    slug: args.slug,
    destDir: args.stateDir,
    databaseUrl: args.databaseUrl,
  });
  const sharedSchema = await pgDumpSharedSchema({
    destDir: args.stateDir,
    databaseUrl: args.databaseUrl,
  });
  const sharedTables = await copyFilteredSharedTables({
    slug: args.slug,
    destDir: args.stateDir,
    databaseUrl: args.databaseUrl,
  });
  return { perHarness, sharedSchema, sharedTables };
}
