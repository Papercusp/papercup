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
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  /**
   * THE BLIND SPOT IN THE CASE ABOVE, and why it needed its own test.
   *
   * A from-scratch replay runs against an EMPTY database. A migration that backfills
   * DATA therefore matches no rows, does nothing, and reports success — so replaying it
   * proves precisely nothing about it. That blind spot shipped: migration 649 passed the
   * check above every time while THE PACKAGED DESKTOP APP COULD NOT BOOT AT ALL
   * (EI-18892214197928842, 0.0.13 deb, 2026-07-28 — `649 guard: 8 mapped target slug(s)
   * are not real pots`, serve.mjs exit 1, sidecar respawn-loop, 502 forever).
   *
   * A real install is not an empty database. The packaged app ships a PRE-MIGRATED SEED
   * (`sidecar/db-seed.tar.gz`) that already contains rows, and the migrations newer than
   * that seed then apply ON TOP of them. So the shape that actually has to work — and the
   * one nothing tested — is: rows present, backfill pending.
   *
   * The second ingredient is a boot-order inversion. `harness_shared.pots` is populated
   * ONLY at runtime, by hive-store.ts; no migration, not even 000-baseline, ever inserts a
   * Pot (asserted below, so this stops being an assumption). Migrations run BEFORE the
   * operator boots, so on a fresh install the pots table is empty BY CONSTRUCTION — and
   * 649 was written against a dev database where those Pots had long existed.
   *
   * This test reproduces both at once: replay everything BEFORE the backfill, seed the row
   * a real install would carry, then let the backfill apply. Nothing is re-applied, so it
   * asserts the from-scratch property the file already guards — just against a database
   * that is not empty.
   */
  it('a pending data-backfill applies against a SEEDED database, not just an empty one', async () => {
    const sqlDir = resolveSqlDir();
    expect(sqlDir).toBeTruthy();

    const files = (await readdir(sqlDir!)).filter((f) => f.endsWith('.sql')).sort();

    // The cut = the first migration that reads Pots AND mutates work_items, i.e. the first
    // one whose behaviour depends on data it did not create. Discovered rather than
    // hardcoded, so a future backfill of the same class is covered the day it lands.
    let cut = -1;
    for (let i = 0; i < files.length; i++) {
      const text = await readFile(join(sqlDir!, files[i]), 'utf8');
      if (
        text.includes('harness_shared.pots') &&
        /(UPDATE|DELETE\s+FROM)\s+harness_shared\.work_items/.test(text)
      ) {
        cut = i;
        break;
      }
    }
    expect(cut, 'expected at least one Pots-driven work_items backfill in the set').toBeGreaterThan(0);

    const seededDb = `bootseed_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${seededDb}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }

    const seededUrl = new URL(adminUri);
    seededUrl.pathname = `/${seededDb}`;
    let client: postgres.Sql | undefined;
    let stageDir = '';

    try {
      const setup = postgres(seededUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
        await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await setup.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
      } finally {
        await setup.end({ timeout: 5 });
      }
      client = postgres(seededUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

      // PHASE 1 — everything strictly BEFORE the backfill. Staged into a temp dir because
      // the runner applies whatever it finds; this is how we stop at the cut without
      // re-applying anything later (re-application would test idempotency, a different
      // property these migrations never promised).
      stageDir = await mkdtemp(join(tmpdir(), 'papercusp-mig-stage-'));
      for (const f of files.slice(0, cut)) await copyFile(join(sqlDir!, f), join(stageDir, f));
      await applyPendingMigrations({ client, sqlDir: stageDir, log: () => {} });

      // The boot-order fact everything above rests on. If a future migration starts
      // seeding Pots this flips to non-zero and the premise needs revisiting — which is
      // exactly why it is asserted rather than assumed.
      const [{ n: pots }] = (await client.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.pots`,
      )) as Array<{ n: number }>;
      expect(pots, 'no migration seeds harness_shared.pots — Pots are created at runtime').toBe(0);

      // The seed a real install carries: a row whose slug is not a Pot here.
      const featureId = `EI-PREFLIGHT-${randomBytes(4).toString('hex')}`;
      await client.unsafe(
        `INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
         VALUES ('papercusp-workspace', 'oddsmith', $1)`,
        [featureId],
      );

      // PHASE 2 — the real directory. The runner skips by filename, so this applies exactly
      // the backfill and everything after it, now with data present.
      const { failed } = await applyPendingMigrations({
        client,
        sqlDir: sqlDir!,
        continueOnError: true,
        log: () => {},
      });

      if (failed.length > 0) {
        const detail = failed.map((f) => `  - ${f.file}: ${f.error}`).join('\n');
        throw new Error(
          `${failed.length} migration(s) FAILED to apply over a SEEDED database (they pass ` +
            `against an empty one, which is why the replay above missed them). A packaged ` +
            `install carries data in its seed and would crash-loop on first boot:\n${detail}`,
        );
      }

      // Declining to backfill must mean "touch nothing" — never "delete what cannot be
      // homed". The row is expected to survive under EITHER slug: untouched if the
      // migration correctly no-ops without a platform Pot, re-homed if one exists.
      const rows = (await client.unsafe(
        `SELECT harness_slug FROM harness_shared.work_items WHERE feature_id = $1`,
        [featureId],
      )) as Array<{ harness_slug: string }>;
      expect(rows, 'the seeded row must survive the backfill, not be silently deleted').toHaveLength(1);
    } finally {
      await client?.end({ timeout: 5 }).catch(() => {});
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      const cleanup = postgres(adminUri, { max: 1, onnotice: () => {} });
      try {
        await cleanup
          .unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${seededDb}' AND pid <> pg_backend_pid()`,
          )
          .catch(() => {});
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${seededDb}"`).catch(() => {});
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    }
  }, 300_000);
});
