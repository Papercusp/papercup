/**
 * baseline-drift — proves `000-baseline.sql` honors the promise in its own
 * generated header: "Idempotent: safe to re-apply against an empty OR an
 * already-populated DB."
 *
 * WI-5216 (2026-07-17) is the live failure this guards. `CREATE TABLE IF NOT
 * EXISTS` is idempotent only against an ABSENT table or one of EXACTLY the same
 * shape; against a pre-existing OLDER table it silently no-ops, so a column the
 * baseline expects is never added and the first index that references it dies —
 * taking the baseline transaction and the whole boot with it.
 *
 * What that cost, concretely: a pre-squash embedded-pg data dir (born
 * 2026-06-01, one day before the baseline squash) carried an `adv_sessions` with
 * no `coord_owner_id`. `000-baseline.sql` wasn't in its schema_migrations, so the
 * runner applied it, `CREATE TABLE IF NOT EXISTS` skipped, and
 * `CREATE INDEX … adv_sessions_coord_owner_idx … (coord_owner_id)` raised
 * `column "coord_owner_id" does not exist`. serve.mjs exited 1 five times into
 * the respawn cap and gave up; the desktop Server ran ~7h with no operator. The
 * user-visible symptom was the Quick Panel global shortcut doing nothing.
 *
 * That DB could not self-heal: `adv_sessions.coord_owner_id` exists ONLY in the
 * baseline — no migration in sql/ adds it — and the baseline sorts FIRST (000),
 * so its failure aborted the run before anything else could apply.
 *
 * These tests run the REAL committed 000-baseline.sql against a REAL Postgres
 * (testcontainer; Docker required) — a unit test over the generator can prove the
 * ADD COLUMN statements are EMITTED, but only Postgres proves they actually
 * REPAIR a drifted table and that the dependent index then builds.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/db-tools/baseline-drift.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const BASELINE_PATH = join(__dirname, '../../../../libs/papercusp/libs/db/sql/000-baseline.sql');

/** The baseline DDL, minus psql metacommands (mirrors the real migration runner). */
function baselineDdl(): string {
  return readFileSync(BASELINE_PATH, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\[a-z]/i.test(l))
    .join('\n');
}

/** Apply the baseline exactly as the runner does: one transaction, no statement cap. */
async function applyBaseline(sql: Sql): Promise<void> {
  await sql.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${baselineDdl()};\nCOMMIT;`);
}

/**
 * The extensions the baseline depends on. Created by embedded-pg's BOOT
 * pre-migration step (cluster-level), NOT by the baseline itself — so a test
 * that applies the baseline must stand them up the same way.
 */
async function createExtensions(sql: Sql): Promise<void> {
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
}

describe('000-baseline.sql — re-apply against a populated, DRIFTED database (WI-5216)', () => {
  let db: MigratedTestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'drift' });
    sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    await createExtensions(sql);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await db?.drop?.().catch(() => {});
  });

  it('THE WI-5216 REGRESSION: converges an OLD-shaped table instead of dying on the index that wants the missing column', async () => {
    // Reproduce the owner's embedded-pg data dir: adv_sessions as it existed
    // BEFORE the squash — no coord_owner_id — and NOT empty, so an un-defaulted
    // NOT NULL add would be a hard error too.
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    await sql.unsafe(`CREATE TABLE harness_shared.adv_sessions (
        id bigint NOT NULL,
        workspace_id text NOT NULL,
        mode text NOT NULL,
        started_at timestamp with time zone DEFAULT now() NOT NULL
      )`);
    await sql.unsafe(
      `INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode) VALUES (1, 'w', 'console')`,
    );

    const pre = await sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema='harness_shared' AND table_name='adv_sessions' AND column_name='coord_owner_id'`;
    expect(pre.length, 'precondition: the drift must be real — column absent').toBe(0);

    // Before the fix this threw: column "coord_owner_id" does not exist.
    await expect(applyBaseline(sql)).resolves.not.toThrow();

    const post = await sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema='harness_shared' AND table_name='adv_sessions' AND column_name='coord_owner_id'`;
    expect(post.length, 'the drifted table must CONVERGE — column added').toBe(1);

    // The exact statement that used to explode must now succeed.
    const idx = await sql`SELECT 1 FROM pg_indexes
      WHERE schemaname='harness_shared' AND indexname='adv_sessions_coord_owner_idx'`;
    expect(idx.length, 'the dependent index must build').toBe(1);

    // Repair must never be destructive — the pre-existing row survives.
    const rows = await sql`SELECT count(*)::int AS n FROM harness_shared.adv_sessions`;
    expect(rows[0].n, 'existing data must be preserved').toBe(1);
  }, 240_000);

  it('is idempotent: a second and third apply over the now-converged DB are clean no-ops', async () => {
    await expect(applyBaseline(sql)).resolves.not.toThrow();
    await expect(applyBaseline(sql)).resolves.not.toThrow();
  }, 240_000);
});

describe('000-baseline.sql — the fresh-install path is unchanged', () => {
  let db: MigratedTestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'fresh' });
    sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    await createExtensions(sql);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await db?.drop?.().catch(() => {});
  });

  it('applies to an EMPTY database and still enforces NOT NULL (the repair pass must not weaken a fresh schema)', async () => {
    await expect(applyBaseline(sql)).resolves.not.toThrow();

    // The ADD COLUMN repair statements strip NOT NULL, but on a fresh DB the
    // CREATE TABLE already ran — so they no-op and nullability must be intact.
    // If this ever fails, the repair pass is clobbering real constraints.
    const notNull = await sql`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='harness_shared' AND table_name='adv_sessions' AND column_name='workspace_id'`;
    expect(notNull[0]?.is_nullable, 'a fresh install keeps NOT NULL').toBe('NO');

    const idx = await sql`SELECT 1 FROM pg_indexes
      WHERE schemaname='harness_shared' AND indexname='adv_sessions_coord_owner_idx'`;
    expect(idx.length).toBe(1);
  }, 240_000);
});
