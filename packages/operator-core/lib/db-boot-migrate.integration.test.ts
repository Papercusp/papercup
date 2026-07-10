/**
 * db-boot-migrate.integration.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A1 — automated coverage for the
 * NATIVE-:5432 boot-apply (the other half of the acceptance: "native box
 * auto-applies on restart").
 *
 * Embedded-pg auto-applies pending sql/*.sql when its server boots; the native
 * dev box had no such runner, so a migration added since the last restart stayed
 * dark until a manual psql. db-boot-migrate.applyPendingMigrationsAtBoot() runs
 * the SAME idempotent runner on host boot, in LOG-AND-CONTINUE mode so one bad
 * migration can't wedge the dev-api the whole fleet shares.
 *
 * Block 1 (runner mechanics, applyPendingMigrations directly):
 *   - applies pending files + records them; a second run is a no-op (idempotent).
 *   - continueOnError:true leaves a broken file in `failed` and KEEPS applying
 *     the rest; the default (fail-loud) THROWS instead.
 *   - the runner's raw BEGIN;…COMMIT; via .unsafe() throws on a POOLED (max>1)
 *     client — which is exactly why the boot helper uses a dedicated max:1
 *     client (regression guard for that design choice).
 * Block 2 (wired entry, applyPendingMigrationsAtBoot):
 *   - drives the runner against the resolved admin DB, applies the good files,
 *     collects the bad one in `failed`, and coord-broadcasts the failure — and
 *     never throws (boot continues).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config';
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';

// ── shared test-DB + mock holders ────────────────────────────────────────────
const h = vi.hoisted(() => ({
  bootUrl: '' as string,
  bootSqlDir: '' as string,
  sendMessage: undefined as unknown as ReturnType<typeof vi.fn>,
}));

// db-boot-migrate builds its OWN max:1 client from getHarnessAdminUrl() and
// resolves the sql dir from resolveSqlDir(); point both at the test fixtures.
vi.mock('./embedded-pg-discovery', async () => {
  const actual = await vi.importActual<typeof import('./embedded-pg-discovery')>('./embedded-pg-discovery');
  return { ...actual, getHarnessAdminUrl: () => h.bootUrl };
});
vi.mock('./migration-drift', async () => {
  const actual = await vi.importActual<typeof import('./migration-drift')>('./migration-drift');
  return { ...actual, resolveSqlDir: () => h.bootSqlDir };
});
// The failure broadcast must not actually touch coord tables (absent in the
// throwaway DB) — capture the call instead.
vi.mock('./agent-tools/coordination/messages', async () => {
  const actual = await vi.importActual<typeof import('./agent-tools/coordination/messages')>(
    './agent-tools/coordination/messages',
  );
  return { ...actual, sendMessage: (...args: unknown[]) => h.sendMessage(...args) };
});

const { applyPendingMigrationsAtBoot } = await import('./db-boot-migrate');

let rootSql: postgres.Sql;
let bootClient: postgres.Sql;
let dbUrl: string;

// EI-8888-adjacent (2026-07-09 host-load root-cause finding): every mkdtemp()
// below lands under the fleet-wide shared TMPDIR (/tmp/pcv — pinned by
// libs/test-config/src/vitest-config.ts) and was NEVER cleaned up. At fleet
// scale that leaked 700k+ stale directories into one dir, degrading every
// mkdir/readdir/stat that touches it (including the testcontainer start-lock
// under the same tree) and contributing to spurious integration-test
// timeouts fleet-wide. Track + remove every dir this file creates.
const createdSqlDirs: string[] = [];

/** Write a temp sql dir with the given { filename: ddl } files. */
function makeSqlDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'a1-boot-'));
  createdSqlDirs.push(dir);
  for (const [name, ddl] of Object.entries(files)) writeFileSync(join(dir, name), ddl);
  return dir;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `bm_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  h.bootUrl = dbUrl;
  h.sendMessage = vi.fn(async () => {});

  rootSql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  bootClient = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
}, 90_000);

afterAll(async () => {
  await bootClient?.end({ timeout: 5 });
  await rootSql?.end({ timeout: 5 });
  await Promise.all(createdSqlDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('boot-apply runner mechanics (§A1)', () => {
  it('applies a pending migration and records it; a re-run is a no-op (idempotent)', async () => {
    const dir = makeSqlDir({ '900-boot-good.sql': 'CREATE TABLE harness_shared.boot_test_a (id int);' });

    const first = await applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} });
    expect(first.appliedCount).toBe(1);
    expect(first.failed).toEqual([]);

    const tracked = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = '900-boot-good.sql'`;
    expect(tracked).toHaveLength(1);

    // Second run: nothing new to apply.
    const second = await applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} });
    expect(second.appliedCount).toBe(0);
  });

  it('continueOnError leaves a broken file pending and keeps applying the rest', async () => {
    const dir = makeSqlDir({
      '910-good.sql': 'CREATE TABLE harness_shared.boot_test_b (id int);',
      '911-bad.sql': 'CREATE TABLE no_such_schema_xyz.bad (id int);', // schema missing → fails
      '912-good.sql': 'CREATE TABLE harness_shared.boot_test_c (id int);',
    });

    const res = await applyPendingMigrations({
      client: bootClient,
      sqlDir: dir,
      continueOnError: true,
      log: () => {},
    });
    expect(res.appliedCount).toBe(2);
    expect(res.failed.map((f) => f.file)).toEqual(['911-bad.sql']);

    // The two good ones are recorded; the bad one is NOT (so it retries next boot).
    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations
       WHERE filename IN ('910-good.sql','911-bad.sql','912-good.sql') ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(['910-good.sql', '912-good.sql']);
  });

  it('the DEFAULT (fail-loud) runner THROWS on a broken migration', async () => {
    const dir = makeSqlDir({ '920-bad.sql': 'CREATE TABLE no_such_schema_xyz.bad2 (id int);' });
    await expect(
      applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} }),
    ).rejects.toThrow();
  });

  it('a POOLED (max>1) client rejects the raw BEGIN;…COMMIT; — why boot uses max:1', async () => {
    const pooled = postgres(dbUrl, { max: 2, onnotice: () => {} });
    try {
      const dir = makeSqlDir({ '930-good.sql': 'CREATE TABLE harness_shared.boot_test_d (id int);' });
      await expect(
        applyPendingMigrations({ client: pooled, sqlDir: dir, log: () => {} }),
      ).rejects.toThrow(/unsafe/i);
    } finally {
      await pooled.end({ timeout: 5 });
    }
  });
});

describe('applyPendingMigrationsAtBoot wired entry (§A1)', () => {
  it('applies pending files, collects the broken one in failed, broadcasts, and does not throw', async () => {
    // The wired entry resolves resolveSqlDir() → this dir and builds its own
    // max:1 client from getHarnessAdminUrl() → the test DB (both mocked above).
    h.bootSqlDir = makeSqlDir({
      '950-good.sql': 'CREATE TABLE harness_shared.boot_wired_a (id int);',
      '951-bad.sql': 'CREATE TABLE no_such_schema_xyz.wired_bad (id int);',
      '952-good.sql': 'CREATE TABLE harness_shared.boot_wired_b (id int);',
    });

    // The helper intentionally console.error()s the failure (the loud, non-fatal
    // surface for a dark migration); suppress it so vitest-fail-on-console
    // doesn't trip, and assert it actually fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof applyPendingMigrationsAtBoot>>;
    let errCalls = 0;
    try {
      result = await applyPendingMigrationsAtBoot();
      errCalls = errSpy.mock.calls.length; // capture before mockRestore clears it
    } finally {
      errSpy.mockRestore();
    }
    expect(errCalls).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    expect(result!.applied).toBe(2);
    expect(result!.failed.map((f) => f.file)).toEqual(['951-bad.sql']);

    // The failure was coord-broadcast (ambient) so peers see the dark migration.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = h.sendMessage.mock.calls[0] as [unknown, { summary: string }];
    expect(payload.summary).toMatch(/failed to apply/i);

    // The two good wired migrations actually landed.
    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations
       WHERE filename IN ('950-good.sql','951-bad.sql','952-good.sql') ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(['950-good.sql', '952-good.sql']);
  });
});
