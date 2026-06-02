/**
 * build-reference-schema.ts — ONE-SHOT reference-schema generator.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 0 (P-002).
 *
 * Builds the COMPLETE `harness_shared` (+ `papercup_shared`) schema the way a
 * fully-booted operator would — by applying ALL SQL migrations *and* invoking
 * every runtime `ensureXxx()` — against a throwaway pgvector container, then
 * `pg_dump`s the result. The dump is the raw input to the sanitizer (P-003),
 * which produces the idempotent `000-baseline.sql`.
 *
 * This tool is INHERENTLY TRANSIENT: it imports `@/lib/ensure-schema`, so it
 * only works while that module still exists. It is DELETED in Phase 2 (P-008)
 * together with ensure-schema. The durable artifact is the baseline it emits.
 *
 *   Run:  cd apps/operator && npx tsx lib/db-tools/build-reference-schema.ts [outPath]
 *   Out:  default /tmp/papercusp-reference-schema.raw.sql
 *
 * Requires Docker (testcontainers) + the `pgvector/pgvector:pg16` image + a
 * `pg_dump` binary on PATH (>= the container's PG major).
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const execFileP = promisify(execFile);

const REPO_ROOT = resolve(process.cwd(), '../..'); // run from apps/operator → repo root
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
// The SECOND, un-unified migration system (applied manually in prod, no runner).
// Creates Group-A ghost tables (agent_actions, agent_queries, el_conv_calls,
// voice_utterances) and renames claude_sessions → delegates (002 → 003).
const COMMANDS_MIGRATIONS_DIR = resolve(REPO_ROOT, 'apps/operator/lib/commands/migrations');
// Captured DDL for the 9 tables the reference build can't reach via migrations/
// ensures: Group B (inline TS runtime DDL) + Group C (true orphans). See the file.
const EXTRA_TABLES_SQL = resolve(REPO_ROOT, 'apps/operator/lib/db-tools/baseline-extra-tables.sql');
const OUT = process.argv[2] ?? '/tmp/papercusp-reference-schema.raw.sql';

// Framework roles the production boot pre-creates. harness_admin is SUPERUSER here
// so migration 016 (`ALTER ROLE harness_admin BYPASSRLS`) + `CREATE EXTENSION` succeed.
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;`;

// The 3 extensions the migrations use (027/039 pgcrypto, 059 pg_trgm, 060 vector).
// Pre-create them so type references (e.g. vector(384) in 081) always resolve.
const EXTENSIONS_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;`;

// autoloop_state is created by a PRIVATE ensureTable() in lib/autoloop.ts (not an
// exported ensure*), so the import-all loop below can't reach it. Replicated here
// verbatim (kept in sync with autoloop.ts) so the baseline includes it.
const AUTOLOOP_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.autoloop_state (
    harness_slug TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'director',
    last_fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_status TEXT,
    consecutive_errors INT NOT NULL DEFAULT 0,
    workspace_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (workspace_id, harness_slug, role)
  );`;

async function main() {
  console.log('[ref-build] starting pgvector/pgvector:pg16 container…');
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('papercusp')
    .withUsername('superuser')
    .withPassword('superuser')
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const superDsn = `postgresql://superuser:superuser@${host}:${port}/papercusp`;
  const adminDsn = `postgresql://harness_admin:harness_admin_pwd@${host}:${port}/papercusp`;
  const appDsn = `postgresql://harness_app:harness_app_pwd@${host}:${port}/papercusp`;

  try {
    // 1. Roles + extensions as the container superuser.
    const su = postgres(superDsn, { max: 1, onnotice: () => {} });
    try {
      await su.unsafe(FRAMEWORK_ROLES_DDL);
      await su.unsafe(EXTENSIONS_DDL);
    } finally {
      await su.end({ timeout: 5 });
    }
    console.log('[ref-build] roles + extensions created');

    // 2. Point the operator's connection layer (getOrgPg) at the scratch DB,
    //    BEFORE importing any module that resolves a pool from env.
    process.env.HARNESS_ADMIN_DATABASE_URL = adminDsn;
    process.env.HARNESS_DATABASE_URL = appDsn;
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';

    // 3. Apply every migration via the real boot-path runner (harness_admin is
    //    SUPERUSER here, so 016 BYPASSRLS + any CREATE EXTENSION succeed).
    const adminSql = postgres(adminDsn, { max: 1, onnotice: () => {} });
    let migResult: { appliedCount: number; totalKnown: number };
    try {
      migResult = await applyPendingMigrations({ client: adminSql, sqlDir: SQL_DIR });
    } finally {
      await adminSql.end({ timeout: 5 });
    }
    console.log(`[ref-build] migrations applied: ${migResult.appliedCount}/${migResult.totalKnown}`);

    // 4. Invoke every runtime ensure (dynamic import AFTER env is set). The
    //    ensures resolve their handle via getOrgPg() → HARNESS_ADMIN_DATABASE_URL.
    const ensureMod = (await import('@/lib/ensure-schema')) as Record<string, unknown>;
    const ensures = Object.entries(ensureMod).filter(
      ([k, v]) => k.startsWith('ensure') && typeof v === 'function',
    ) as Array<[string, () => Promise<void>]>;
    console.log(`[ref-build] invoking ${ensures.length} ensureXxx() (multi-pass for ordering)…`);

    // Multi-pass: a few ensures may depend on a table another ensure creates.
    // Retry the failing set until no further progress, then surface remainders.
    let pending = ensures;
    const lastErr = new Map<string, string>();
    for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
      const stillFailing: Array<[string, () => Promise<void>]> = [];
      for (const [name, fn] of pending) {
        try {
          await fn();
        } catch (err) {
          stillFailing.push([name, fn]);
          lastErr.set(name, (err as Error)?.message?.split('\n')[0] ?? String(err));
        }
      }
      if (stillFailing.length === pending.length) break; // no progress → stop
      pending = stillFailing;
    }
    if (pending.length > 0) {
      console.error('[ref-build] ensures that never succeeded:');
      for (const [name] of pending) console.error(`  ${name}: ${lastErr.get(name)}`);
      throw new Error(`${pending.length} ensure(s) failed after multi-pass`);
    }

    // 5. Dogfood ensures (their own batch) + the autoloop table.
    const dogMod = (await import('@/lib/ensure-schema-dogfood')) as {
      ensureAllDogfoodTables: () => Promise<void>;
    };
    await dogMod.ensureAllDogfoodTables();
    const autoSql = postgres(adminDsn, { max: 1, onnotice: () => {} });
    try {
      await autoSql.unsafe(AUTOLOOP_STATE_DDL);
    } finally {
      await autoSql.end({ timeout: 5 });
    }
    console.log('[ref-build] dogfood + autoloop ensures done');

    // 5b. Re-run migrations now that the ensures created the tables the first
    //     pass was missing (e.g. 097 needs feature_queue). This mirrors the real
    //     operator's multi-boot retry: a migration skipped on 42P01 applies once
    //     its dependency table exists. Loop until no further progress.
    for (let pass = 0; pass < 4; pass++) {
      const c = postgres(adminDsn, { max: 1, onnotice: () => {} });
      let applied: number;
      try {
        ({ appliedCount: applied } = await applyPendingMigrations({ client: c, sqlDir: SQL_DIR }));
      } finally {
        await c.end({ timeout: 5 });
      }
      console.log(`[ref-build] migration retry pass ${pass + 1}: +${applied}`);
      if (applied === 0) break;
    }

    // 5c. Apply the SECOND migration system + the captured extra-tables fragment so
    //     the dump is the COMPLETE schema (184 tables), not just the migration+ensure
    //     subset (170). These cover the 14 "ghost" tables a pure reference build misses:
    //       • apps/operator/lib/commands/migrations/*.sql — Group A (agent_actions,
    //         agent_queries, el_conv_calls, voice_utterances) + the claude_sessions →
    //         delegates rename (002 → 003). Applied as harness_admin (SUPERUSER here, so
    //         the GRANTs land). Run via psql for multi-statement/dollar-quote fidelity.
    //       • baseline-extra-tables.sql — Group B (inline TS runtime DDL) + Group C (true
    //         orphans with no active creator). Captured DDL.
    const cmdFiles = readdirSync(COMMANDS_MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    console.log(`[ref-build] applying ${cmdFiles.length} commands/migrations + extra-tables fragment…`);
    const psqlFail = new Map<string, string>();
    for (const f of [...cmdFiles.map((f) => resolve(COMMANDS_MIGRATIONS_DIR, f)), EXTRA_TABLES_SQL]) {
      try {
        await execFileP('psql', [adminDsn, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
      } catch (err) {
        psqlFail.set(f, (err as { stderr?: string })?.stderr?.split('\n').slice(-3).join(' ') ?? String(err));
      }
    }
    if (psqlFail.size > 0) {
      console.error('[ref-build] commands/migrations + fragment files that errored:');
      for (const [f, e] of psqlFail) console.error(`  ${f.replace(REPO_ROOT, '.')}: ${e}`);
      throw new Error(`${psqlFail.size} commands-migration/fragment file(s) failed`);
    }
    console.log('[ref-build] 2nd migration system + extra-tables fragment applied');

    // 6. Dump the global schemas (schema-only, no owner/privs — the sanitizer
    //    handles idempotency; ownership/GRANT are stripped here).
    await execFileP('pg_dump', [
      superDsn,
      '--schema-only',
      '--schema=harness_shared',
      '--schema=papercup_shared',
      '--no-owner',
      '--no-privileges',
      '-f',
      OUT,
    ]);

    // 7. Quick stats for the operator.
    const verify = postgres(superDsn, { max: 1, onnotice: () => {} });
    try {
      const [{ tables }] = await verify.unsafe(
        `SELECT count(*)::int AS tables FROM information_schema.tables
         WHERE table_schema IN ('harness_shared','papercup_shared') AND table_type='BASE TABLE'`,
      );
      const [{ idx }] = await verify.unsafe(
        `SELECT count(*)::int AS idx FROM pg_indexes
         WHERE schemaname IN ('harness_shared','papercup_shared')`,
      );
      console.log(`[ref-build] DONE → ${OUT}`);
      console.log(`[ref-build] schema: ${tables} tables, ${idx} indexes`);
    } finally {
      await verify.end({ timeout: 5 });
    }
  } finally {
    await container.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[ref-build] FAILED:', e?.stack ?? e);
    process.exit(1);
  });
