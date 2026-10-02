#!/usr/bin/env node
// Logical Phone database backup and an actual restore into a disposable PG.
// This is source-build preparation; it never changes the running Phone database.
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

process.umask(0o077);
const DUMP_BIN = process.env.PHONE_PG_DUMP_BIN || 'pg_dump';
const RESTORE_BIN = process.env.PHONE_PG_RESTORE_BIN || 'pg_restore';
const repoRoot = resolve(import.meta.dirname, '../..');

function connectionEnv(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid Phone database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      !url.username || !url.pathname.slice(1) || url.hash) {
    throw new Error('invalid Phone database URL');
  }
  const sslmode = url.searchParams.get('sslmode');
  if ([...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      (sslmode && !['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode))) {
    throw new Error('unsupported Phone database URL options');
  }
  // Clear inherited libpq overrides so discovery selects the same database
  // that the Phone sidecar uses. Keep passwords out of process arguments.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^PG[A-Z]/.test(key) && !/^PHONE_/.test(key)));
  return {
    ...env,
    PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
  };
}

async function sourceUrl() {
  const explicit = process.env.PHONE_APP_DATABASE_URL || process.env.PHONE_DATABASE_URL || process.env.DATABASE_URL;
  if (explicit) return explicit;
  const home = process.env.PHONE_HOME?.trim() || join(homedir(), '.papercusp-phone');
  let discovery;
  try { discovery = JSON.parse(await readFile(join(home, 'postgres.json'), 'utf8')); }
  catch { throw new Error('Phone database discovery unavailable'); }
  if (typeof discovery.url !== 'string') throw new Error('Phone database discovery has no URL');
  return discovery.url;
}

function run(program, args, env = process.env, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { env, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let output = '';
    if (capture) child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 10 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.resume();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${program} could not start: ${error.code || 'spawn failure'}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${program} timed out`));
      else if (code !== 0) reject(new Error(`${program} failed (exit ${code ?? 'signal'})`));
      else resolveRun(output);
    });
  });
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function backup(out) {
  if (!isAbsolute(out)) throw new Error('backup output must be an absolute path outside the source tree');
  out = resolve(out);
  if (out === repoRoot || out.startsWith(`${repoRoot}${sep}`)) {
    throw new Error('backup output must be outside the source tree');
  }
  const raw = await sourceUrl();
  const { default: postgres } = await import('postgres');
  const sql = postgres(raw, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const [row] = await sql`SELECT to_regclass('public.phone_calls') AS phone_calls`;
    if (!row?.phone_calls) throw new Error('source database has no Phone call ledger');
  } catch (error) {
    if (error instanceof Error && error.message === 'source database has no Phone call ledger') throw error;
    throw new Error('Phone source database preflight failed');
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
  const env = connectionEnv(raw);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  if (((await stat(dirname(out))).mode & 0o077) !== 0) {
    throw new Error('backup directory must be private (mode 0700)');
  }
  const temp = `${out}.${randomUUID()}.tmp`;
  const receiptTemp = `${temp}.sha256`;
  let published = false;
  try {
    await run(DUMP_BIN, ['--format=custom', '--no-owner', '--no-privileges', '--schema=public', `--file=${temp}`], env);
    await chmod(temp, 0o600);
    if ((await stat(temp)).size < 5) throw new Error('Phone database dump is empty');
    await run(RESTORE_BIN, ['--list', temp]);
    const sha256 = await digest(temp);
    await writeFile(receiptTemp, `${sha256}\n`, { mode: 0o600, flag: 'wx' });
    // link() refuses an existing destination. A rerun cannot clobber a prior
    // recovery point, and a failed receipt publication removes our archive.
    await link(temp, out);
    published = true;
    await link(receiptTemp, `${out}.sha256`);
    console.log(JSON.stringify({ ok: true, action: 'backup', archive: out, sha256 }));
  } catch (error) {
    if (published) await unlink(out).catch(() => {});
    throw error;
  } finally {
    await Promise.all([unlink(temp).catch(() => {}), unlink(receiptTemp).catch(() => {})]);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('cannot reserve drill port')); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function drill(archive) {
  if (!isAbsolute(archive)) throw new Error('drill archive must be an absolute path');
  archive = resolve(archive);
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid Phone backup digest receipt');
  const actual = await digest(archive);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new Error('Phone backup digest mismatch');
  }
  const toc = await run(RESTORE_BIN, ['--list', archive], process.env, true);

  const work = await mkdtemp(join(tmpdir(), 'phone-db-restore-drill-'));
  // The embedded PG package may unref its child while an async bootstrap is
  // pending. Keep the one-shot CLI alive until the drill has proof or fails.
  const keepAlive = setInterval(() => {}, 1_000);
  let server;
  try {
    // A fresh embedded cluster pre-installs extensions in public. The dump's
    // CREATE SCHEMA public entry would conflict; removing just that TOC entry
    // keeps every Phone table, row, index and constraint in the actual restore.
    const list = join(work, 'restore.list');
    await writeFile(list, toc.split('\n').map(line =>
      /^\d+; \d+ \d+ SCHEMA - public(?:\s|$)/.test(line) ? `;${line}` : line).join('\n'),
    { mode: 0o600 });
    const { startEmbeddedPostgresServer } = await import('@papercusp/embedded-postgres-server');
    server = await startEmbeddedPostgresServer({ dataDir: join(work, 'pg'),
      dbName: 'phone_restore_drill', port: await freePort(), onLog: () => {} });
    await run(RESTORE_BIN, ['--exit-on-error', '--no-owner', '--no-privileges',
      `--use-list=${list}`, '--dbname=phone_restore_drill', archive], connectionEnv(server.urls.admin));
    const { default: postgres } = await import('postgres');
    const sql = postgres(server.urls.admin, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      if (!tables.some(row => row.tablename === 'phone_calls')) {
        throw new Error('Phone restore has no phone_calls table');
      }
      const nonEmptyTables = [];
      for (const { tablename } of tables) {
        const quoted = `"${tablename.replaceAll('"', '""')}"`;
        const [row] = await sql.unsafe(`SELECT EXISTS (SELECT 1 FROM public.${quoted} LIMIT 1) AS has_row`);
        if (row.has_row) nonEmptyTables.push(tablename);
      }
      console.log(JSON.stringify({ ok: true, action: 'restore-drill', archive,
        sha256: actual, tablesVerified: tables.length, nonEmptyTables }));
    } finally { await sql.end({ timeout: 5 }); }
  } finally {
    try { if (server) await server.stop(); }
    finally {
      clearInterval(keepAlive);
      await rm(work, { recursive: true, force: true });
    }
  }
}

try {
  const [action, flag, path, ...rest] = process.argv.slice(2);
  if (rest.length || !path || (action === 'backup' && flag !== '--out') ||
      (action === 'restore-drill' && flag !== '--archive') ||
      !['backup', 'restore-drill'].includes(action)) {
    throw new Error('usage: phone-db-backup.mjs backup --out /absolute/path.dump | restore-drill --archive /absolute/path.dump');
  }
  if (action === 'backup') await backup(path);
  else await drill(path);
} catch (error) {
  // libpq URLs and secret values never enter diagnostic output.
  console.error(`phone-db-backup: ${error instanceof Error ? error.message : 'unknown failure'}`);
  // The embedded PG dependency can install process lifecycle handlers; make a
  // refused backup or failed restore an unambiguous nonzero CLI verdict.
  process.exit(1);
}
