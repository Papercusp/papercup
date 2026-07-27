/**
 * release-preflight-migration-boot-smoke.integration.test.ts
 *
 * release-readiness-preflight-gate-2026-07-19 P-001 — the CROWN-JEWEL preflight.
 *
 * WHAT IT GUARDS
 * A packaged operator, on FIRST BOOT of a clean install, runs the embedded-pg
 * boot path: a fresh `initdb` cluster → create the framework roles + extensions
 * → apply EVERY `libs/papercusp/libs/db/sql/*.sql` in filename order (000-baseline
 * then 104…N). If any migration crashes mid-replay the seed crash-loops and the
 * install is dead. That is exactly what migration 631 (a migration-vs-seed
 * dup-key) did on the 0.0.12 cut — and it was found ONLY after a ~45-min build +
 * install + boot, because the ordinary integration suite NEVER exercises this
 * path: it provisions test DBs from the SQUASHED 000-baseline snapshot (or a
 * template clone), so incremental migrations 104…N are never replayed from
 * scratch in CI. This test closes that gap: it replays the FULL real migration
 * set against a virgin database and asserts none fail — catching the 631 class
 * in ~minutes, before any platform build starts.
 *
 * FIDELITY
 * The preamble mirrors @papercusp/embedded-postgres-server's own boot preamble
 * (src/index.js): the roles harness_app / harness_admin / harness_zero
 * (getTestPg already ensures these cluster-wide) and the extensions pgcrypto /
 * pg_trgm / vector — created BEFORE the migrations run, because a migration may
 * use gen_random_uuid()/trigram ops/vector columns and 000-baseline itself does
 * NOT `CREATE EXTENSION`. The runner is the SAME applyPendingMigrations embedded-pg
 * uses at boot, on a dedicated max:1 client (its raw BEGIN;…COMMIT; via .unsafe()
 * is rejected on a pooled connection). We run continueOnError:true so a single
 * bad migration does not mask later ones — the assertion is that `failed` is
 * EMPTY, and any failures are reported with file + error for a fast fix.
 *
 * Requires Docker (shared testcontainers PG, pgvector/pgvector:pg18 — the image
 * chosen precisely because 000-baseline needs the `vector` extension). The fresh
 * database this creates is dropped in cleanup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';
// Types come from the package's generated `src/index.d.ts` (EI-18804531117413708).
// This was a verbatim copy of db-boot-migrate.ts's `@ts-expect-error` +
// hand-written `ApplyPendingMigrations` cast; both are gone now that the real
// signature is generated from the source's JSDoc.
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { resolveSqlDir } from './migration-drift';

// The runner applies each file as a raw `BEGIN; <ddl>; COMMIT;` via .unsafe(),
// which postgres-js rejects on a pooled (max>1) connection — so this MUST be
// max:1, exactly like the embedded-pg boot runner and db-boot-migrate.
let bootClient: postgres.Sql | undefined;
let dbName = '';
let adminUri = '';

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `bootsmoke_${randomBytes(5).toString('hex')}`;

  // Create a VIRGIN database — never the shared default DB (other tests have
  // populated it); we need a from-scratch replay.
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;

  // Mirror the embedded-pg boot preamble: extensions the migration set relies on,
  // created before any migration runs (roles are cluster-wide via getTestPg).
  const setup = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  } finally {
    await setup.end({ timeout: 5 });
  }

  bootClient = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await bootClient?.end({ timeout: 5 }).catch(() => {});
  if (dbName && adminUri) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin
        .unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        )
        .catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
});

describe('release preflight: cold-seed migration boot-smoke (P-001)', () => {
  it('every real libs/db/sql migration applies cleanly from scratch (the migration-631 class)', async () => {
    const sqlDir = resolveSqlDir();
    expect(sqlDir, 'resolveSqlDir() must locate the real migrations dir').toBeTruthy();

    const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
      client: bootClient!,
      sqlDir: sqlDir!,
      // Collect ALL failures rather than aborting on the first, so the report
      // names every broken migration in one pass.
      continueOnError: true,
      log: () => {},
    });

    if (failed.length > 0) {
      const detail = failed.map((f) => `  - ${f.file}: ${f.error}`).join('\n');
      throw new Error(
        `${failed.length} migration(s) FAILED to apply on a from-scratch replay ` +
          `(${appliedCount}/${totalKnown} applied). A packaged install would crash-loop ` +
          `its seed on first boot. Fix these before cutting a release:\n${detail}`,
      );
    }

    // Sanity: this really replayed the full set, not a no-op against a pre-migrated DB.
    expect(appliedCount).toBe(totalKnown);
    expect(appliedCount).toBeGreaterThan(500);
  }, 300_000);
});
