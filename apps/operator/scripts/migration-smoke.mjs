#!/usr/bin/env node
/**
 * Migration smoke test.
 *
 * Boot embedded-postgres-server against a fresh tmpdir, apply every
 * SQL file in libs/papercusp/libs/db/sql/ in order via the runtime's
 * own migration-runner, and assert:
 *
 *   1. No applied-migration ever errors.
 *   2. Three load-bearing tables exist after boot:
 *        - harness_shared.harness_summaries
 *        - harness_shared.pending_reviews
 *        - harness_shared.harness_proposals_shared
 *      These are required by /api/zero-harness/rest-query for every
 *      Zero-driven panel; absence silently empties the dashboard.
 *   3. schema_migrations contains every non-template SQL file.
 *
 * Why this test exists: 2026-05-06 we shipped 017-...sql which ALTERed
 * harness_summaries without first creating it (the table was being
 * created lazily by apps/operator/lib/ensure-schema.ts at runtime, which
 * the bootstrap migration runner doesn't trigger). On a fresh data dir
 * the desktop app crashed before the operator could even boot. This
 * smoke test would have caught that the moment 017 was authored.
 *
 * Usage:
 *   node apps/operator/scripts/migration-smoke.mjs
 *
 * Exits 0 on success, non-zero with diagnostic output on any failure.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';

const REQUIRED_TABLES = [
  ['harness_shared', 'harness_summaries'],
  ['harness_shared', 'pending_reviews'],
  ['harness_shared', 'harness_proposals_shared'],
  ['harness_shared', 'projects'],
  ['harness_shared', 'audit_log'],
  ['harness_shared', 'plugin_enables'],
  ['harness_shared', 'plugin_configs'],
  ['harness_shared', 'schema_migrations'],
];

// Resolve from the operator directory: apps/operator/scripts → repo
// root → libs/papercusp/libs/db/sql.
const SQL_DIR = join(
  new URL('../../..', import.meta.url).pathname,
  'libs/papercusp/libs/db/sql',
);

let dataDir;
let handle;
let exitCode = 0;

try {
  dataDir = await mkdtemp(join(tmpdir(), 'papercusp-migration-smoke-'));
  console.log(`[migration-smoke] data dir: ${dataDir}`);
  console.log(`[migration-smoke] sql dir:  ${SQL_DIR}`);

  handle = await startEmbeddedPostgresServer({
    dataDir,
    port: 0, // ephemeral
    dbName: 'papercusp_smoke',
    dbSqlDir: SQL_DIR,
    log: (msg) => console.log(`[pg] ${msg}`),
  });

  const sql = handle.sql;

  // Assertion 1: every required table exists.
  for (const [schema, table] of REQUIRED_TABLES) {
    const rows = await sql`
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = ${schema} AND table_name = ${table}
    `;
    if (rows.length === 0) {
      console.error(`[migration-smoke] FAIL: ${schema}.${table} does not exist after boot`);
      exitCode = 1;
    } else {
      console.log(`[migration-smoke] ok: ${schema}.${table}`);
    }
  }

  // Assertion 2: schema_migrations has every non-template SQL file.
  const { readdir } = await import('node:fs/promises');
  const sqlFiles = (await readdir(SQL_DIR))
    .filter((f) => f.endsWith('.sql') && !f.includes('per-harness-template'))
    .sort();
  const appliedRows = await sql`SELECT filename FROM harness_shared.schema_migrations`;
  const applied = new Set(appliedRows.map((r) => r.filename));
  for (const f of sqlFiles) {
    if (!applied.has(f)) {
      console.error(`[migration-smoke] FAIL: ${f} not recorded in schema_migrations`);
      exitCode = 1;
    }
  }
  console.log(
    `[migration-smoke] schema_migrations: ${applied.size}/${sqlFiles.length} files recorded`,
  );

  if (exitCode === 0) {
    console.log('[migration-smoke] PASS');
  }
} catch (err) {
  console.error('[migration-smoke] FAIL:', err.message);
  if (err.stack) console.error(err.stack);
  exitCode = 1;
} finally {
  if (handle?.stop) {
    try {
      await handle.stop();
    } catch {
      /* best effort */
    }
  }
  if (dataDir) {
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

process.exit(exitCode);
