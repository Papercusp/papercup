/**
 * dogfood-gap-check.ts — TRANSIENT. Find every schema object the runtime
 * ensure-schema-dogfood.ts adds that the migration set does NOT yet contain.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, P-008b prep. The reference
 * build invoked ensureAllDogfoodTables() but NOT wireDogfoodTriggers(), so the
 * baseline missed the reactivity triggers (fixed by 107) and P-070's
 * contributor_usage_events.origin + capture trigger (flagged by a peer). This proves
 * whether any OTHER dogfood DDL is still missing, so migration 108 can be complete.
 *
 * Method: one pgvector DB → roles+ext → apply migrations → dump D1; then invoke
 * wireDogfoodTriggers() (calls ensureAllDogfoodTables internally) → dump D2; diff.
 * D2 \ D1 = the exact gap. Delete this file once dogfood is removed (P-008b).
 *
 *   Run: cd apps/operator && npx tsx lib/db-tools/dogfood-gap-check.ts
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
// eslint-disable-next-line import/no-relative-packages
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(process.cwd(), '../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const ROLES_EXT = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;`;

async function dump(superDsn: string, out: string) {
  await execFileP('pg_dump', [superDsn, '--schema-only', '--schema=harness_shared', '--schema=papercup_shared', '--no-owner', '--no-privileges', '-f', out]);
}

async function main() {
  const c = await new PostgreSqlContainer('pgvector/pgvector:pg16').withDatabase('papercusp').withUsername('su').withPassword('su').start();
  const superDsn = `postgresql://su:su@${c.getHost()}:${c.getPort()}/papercusp`;
  const adminDsn = `postgresql://harness_admin:harness_admin_pwd@${c.getHost()}:${c.getPort()}/papercusp`;
  try {
    const su = postgres(superDsn, { max: 1, onnotice: () => {} });
    await su.unsafe(ROLES_EXT); await su.end({ timeout: 5 });

    process.env.HARNESS_ADMIN_DATABASE_URL = adminDsn;
    process.env.HARNESS_DATABASE_URL = adminDsn;
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';

    const admin = postgres(adminDsn, { max: 1, onnotice: () => {} });
    await applyPendingMigrations({ client: admin, sqlDir: SQL_DIR });
    await admin.end({ timeout: 5 });
    await dump(superDsn, '/tmp/dogfood-D1.sql');
    console.log('[gap-check] D1 = migrations-only dumped');

    // Invoke the runtime dogfood wiring (ensureAllDogfoodTables is called inside).
    const dog = (await import('@/lib/ensure-schema-dogfood')) as {
      wireDogfoodTriggers: () => Promise<void>;
      ensureAllDogfoodTables: () => Promise<void>;
    };
    await dog.ensureAllDogfoodTables();
    await dog.wireDogfoodTriggers();
    await dump(superDsn, '/tmp/dogfood-D2.sql');
    console.log('[gap-check] D2 = migrations + dogfood dumped');

    // Normalize + diff (drop volatile \restrict keys, comments, SET, blanks).
    const norm = (s: string) => s.split('\n').filter((l) => !/^\\(un)?restrict |^--|^SET |^SELECT pg_catalog|^\s*$/.test(l));
    const { readFileSync } = await import('node:fs');
    const d1 = new Set(norm(readFileSync('/tmp/dogfood-D1.sql', 'utf8')));
    const d2 = norm(readFileSync('/tmp/dogfood-D2.sql', 'utf8'));
    const gap = d2.filter((l) => !d1.has(l) && /CREATE|ALTER|ADD|TRIGGER|COLUMN/.test(l));
    writeFileSync('/tmp/dogfood-gap.txt', gap.join('\n'));
    console.log(`\n[gap-check] ===== ${gap.length} DDL lines in D2 not in D1 (the gap migration 108 must cover) =====`);
    for (const l of gap) console.log('  ' + l.trim().slice(0, 160));
  } finally {
    await c.stop();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e?.stack ?? e); process.exit(1); });
