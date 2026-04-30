/**
 * Postgres capture for snapshots — §15.5 steps 3 + 4.
 *
 *   1. pg_dump --schema=harness_<slug>          → state/db.sql.gz
 *   2. pg_dump --schema=harness_shared --schema-only → state/shared-schema.sql
 *   3. For each included shared table, COPY (filtered) TO STDOUT csv, HEADER
 *      → state/shared-<table>.csv
 *
 * The DB connection URL defaults to `HARNESS_ADMIN_DATABASE_URL` (admin
 * role; needed to dump full DDL + cross-schema reads). Caller can override
 * via `CaptureRequest.databaseUrl`.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
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

function run(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts.input != null) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
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

export async function pgDumpPerHarness(args: {
  slug: string;
  destDir: string;
  databaseUrl?: string;
}): Promise<{ outPath: string }> {
  assertValidSlug(args.slug);
  const url = resolveDatabaseUrl(args.databaseUrl);
  const outPath = join(args.destDir, 'db.sql.gz');
  const r = await runStream(
    'pg_dump',
    [
      `--schema=harness_${args.slug}`,
      '--no-owner',
      '--no-privileges',
      '--compress=4',
      url,
    ],
    outPath,
  );
  if (r.code !== 0) {
    throw new Error(`pg_dump per-harness failed (code ${r.code}): ${r.stderr.trim()}`);
  }
  return { outPath };
}

export async function pgDumpSharedSchema(args: {
  destDir: string;
  databaseUrl?: string;
}): Promise<{ outPath: string }> {
  const url = resolveDatabaseUrl(args.databaseUrl);
  const outPath = join(args.destDir, 'shared-schema.sql');
  const r = await runStream(
    'pg_dump',
    ['--schema-only', '--schema=harness_shared', '--no-owner', '--no-privileges', url],
    outPath,
  );
  if (r.code !== 0) {
    throw new Error(`pg_dump shared schema failed (code ${r.code}): ${r.stderr.trim()}`);
  }
  return { outPath };
}

export async function copyFilteredSharedTables(args: {
  slug: string;
  destDir: string;
  databaseUrl?: string;
}): Promise<{ written: { table: string; outPath: string; rowCount: number }[] }> {
  assertValidSlug(args.slug);
  const url = resolveDatabaseUrl(args.databaseUrl);
  const written: { table: string; outPath: string; rowCount: number }[] = [];
  for (const entry of includedSharedTables()) {
    const where = entry.filter(args.slug);
    const sql = `\\COPY (SELECT * FROM harness_shared.${entry.table} WHERE ${where}) TO STDOUT WITH (FORMAT csv, HEADER)`;
    const outPath = join(args.destDir, `shared-${entry.table}.csv`);
    const r = await runStream('psql', ['-X', '-A', '-q', '-c', sql, url], outPath);
    if (r.code !== 0) {
      throw new Error(
        `COPY shared.${entry.table} failed (code ${r.code}): ${r.stderr.trim()}`,
      );
    }
    const stat = await fs.stat(outPath);
    // First line is header; row count = lines - 1, with empty file edge.
    let rowCount = 0;
    if (stat.size > 0) {
      const txt = await fs.readFile(outPath, 'utf8');
      rowCount = Math.max(0, txt.split('\n').filter((l) => l.length > 0).length - 1);
    }
    written.push({ table: entry.table, outPath, rowCount });
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
