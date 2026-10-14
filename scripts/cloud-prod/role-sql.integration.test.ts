/**
 * The production role bootstrap and the full migration set, run as NON-superusers on a cluster
 * shaped like Cloud SQL (plan cloud-portal-public-release-2026-10-13, P-004 / P-005, D-010).
 *
 * Every other bootstrap in the repo makes harness_admin SUPERUSER, so before this test nothing
 * ever ran the migration set the way production will. The cluster here models what the live
 * catalog probe of pc-cloud-prod-pg showed (2026-10-14): a `postgres` that has CREATEROLE and
 * CREATEDB, belongs to cloudsqlsuperuser, and is NOT a superuser; databases owned by
 * cloudsqlsuperuser. The cluster's own superuser stands in for Cloud SQL itself and does only
 * what Cloud SQL does: create those roles and databases, and the allowlisted extensions
 * (`gcloud sql databases create` + the cloudsqlsuperuser extension allowlist).
 *
 * Needs native PG binaries with pgvector (/usr/lib/postgresql/<major>/bin), no Docker.
 */
import postgres, { type Sql } from 'postgres';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { ownerRoleSql } from './provision-cloud-sql';
import { HOSTED_DATABASE, HOSTED_ROLES, productionRoleSql } from './role-sql';
import { generatePassword, scramSha256Verifier } from './scram';

const SQL_DIR = fileURLToPath(new URL('../../libs/papercusp/libs/db/sql/', import.meta.url));
const RUNNER = new URL('../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js', import.meta.url).href;

/** Cloud SQL's built-in `postgres` (the cluster superuser already owns that name). */
const CLOUD_POSTGRES = 'csql_postgres';

/**
 * Migrations a managed Postgres cannot apply as written. EXACT set: when one starts passing,
 * this test fails until it is removed here, so a stale allowance cannot hide a regression.
 * 733 = `GRANT pg_read_all_stats TO harness_admin`, which needs ADMIN OPTION nobody holds on
 * Cloud SQL. Open product decision: WI-6554700010011218 / conv-mv7s6wyw-0000-3e3d77cb54b746e68409fd3c0c13f035.
 */
const KNOWN_MANAGED_PG_GAPS = ['733-grant-pg-read-all-stats-harness-admin.sql'];

let pg: DedicatedNativePg;
const clients: Sql[] = [];

function connect(user: string, database: string): Sql {
  const url = new URL(pg.getConnectionUri());
  url.username = user;
  url.password = '';
  url.pathname = `/${database}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  clients.push(sql);
  return sql;
}

const verifier = () => scramSha256Verifier(generatePassword());

/** Run the whole bootstrap as Cloud SQL's `postgres`, the way `up` does through ExecuteSql. */
async function bootstrap(): Promise<void> {
  const inPostgres = connect(CLOUD_POSTGRES, 'postgres');
  const inHosted = connect(CLOUD_POSTGRES, HOSTED_DATABASE);
  for (const db of [HOSTED_DATABASE, 'portal']) {
    const owner = ownerRoleSql(db, verifier());
    await inPostgres.unsafe(owner.inPostgres);
    await connect(CLOUD_POSTGRES, db).unsafe(owner.inDatabase);
  }
  const hosted = productionRoleSql({ adminVerifier: verifier(), appVerifier: verifier() });
  await inPostgres.unsafe(hosted.inPostgres);
  await inHosted.unsafe(hosted.inDatabase);
}

beforeAll(async () => {
  pg = await startDedicatedNativePg({
    settings: { fsync: 'off', synchronous_commit: 'off', full_page_writes: 'off', shared_preload_libraries: 'pg_stat_statements' },
  });
  const cloudSql = connect('postgres', 'postgres');
  // One statement per call: CREATE DATABASE refuses the implicit transaction of a multi-statement query.
  for (const stmt of [
    'CREATE ROLE cloudsqlsuperuser NOLOGIN CREATEROLE CREATEDB',
    `CREATE ROLE ${CLOUD_POSTGRES} LOGIN CREATEROLE CREATEDB IN ROLE cloudsqlsuperuser`,
    `CREATE DATABASE ${HOSTED_DATABASE} OWNER cloudsqlsuperuser`,
    'CREATE DATABASE portal OWNER cloudsqlsuperuser',
  ]) {
    await cloudSql.unsafe(stmt);
  }
  // Cloud SQL lets cloudsqlsuperuser members create allowlisted extensions; vanilla PG does not.
  const hosted = productionRoleSql({ adminVerifier: verifier(), appVerifier: verifier() });
  await connect('postgres', HOSTED_DATABASE).unsafe(hosted.extensions);
}, 120_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 }).catch(() => undefined)));
  await pg?.stop();
});

describe('production role bootstrap as a non-superuser (D-010)', () => {
  it('runs twice: the second run takes every ALTER branch and still succeeds', async () => {
    await bootstrap();
    await bootstrap();
  });

  it('leaves every role non-superuser, harness_admin able to create roles it can then use', async () => {
    const rows = await connect('postgres', 'postgres')<Array<Record<string, unknown>>>`
      SELECT rolname, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
             coalesce(rolconfig, '{}') AS rolconfig,
             pg_has_role(rolname, 'cloudsqlsuperuser', 'MEMBER') AS csu
        FROM pg_roles WHERE rolname IN ('harness_admin', 'harness_app', 'harness_zero', 'papercusp_hosted_owner')
       ORDER BY rolname`;
    const by = Object.fromEntries(rows.map((r) => [r.rolname, r]));
    for (const r of rows) {
      expect({ role: r.rolname, rolsuper: r.rolsuper, rolreplication: r.rolreplication, rolbypassrls: r.rolbypassrls, csu: r.csu }).toEqual({
        role: r.rolname,
        rolsuper: false,
        rolreplication: false,
        rolbypassrls: false,
        csu: false,
      });
    }
    expect(by.harness_admin).toMatchObject({ rolcanlogin: true, rolcreaterole: true, rolcreatedb: false });
    expect(by.harness_admin!.rolconfig).toContain('createrole_self_grant=set, inherit');
    expect(by.harness_app).toMatchObject({ rolcanlogin: true, rolcreaterole: false });
    expect(by.harness_zero).toMatchObject({ rolcanlogin: false });
  });

  it('keeps harness_admin and harness_app out of every other database', async () => {
    for (const role of [HOSTED_ROLES.admin, HOSTED_ROLES.app]) {
      await expect(connect(role, 'portal')`SELECT 1`).rejects.toThrow(/permission denied for database "?portal"?/);
      await expect(connect(role, HOSTED_DATABASE)`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    }
  });

  it('lets harness_app create the temp tables the scheduler uses', async () => {
    const app = connect(HOSTED_ROLES.app, HOSTED_DATABASE);
    await app.unsafe('CREATE TEMP TABLE scratch_probe (x int)');
    await expect(app`SELECT count(*)::int AS n FROM scratch_probe`).resolves.toEqual([{ n: 0 }]);
  });

  it('applies the full migration set as harness_admin, failing only the known managed-PG gaps', async () => {
    const { applyPendingMigrations } = (await import(RUNNER)) as {
      applyPendingMigrations: (o: Record<string, unknown>) => Promise<{
        appliedCount: number;
        totalKnown: number;
        failed: Array<{ file: string; error: unknown }>;
      }>;
    };
    const admin = connect(HOSTED_ROLES.admin, HOSTED_DATABASE);
    const [who] = await admin<Array<{ su: boolean }>>`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`;
    expect(who!.su).toBe(false);
    const res = await applyPendingMigrations({
      client: admin,
      sqlDir: SQL_DIR,
      continueOnError: true,
      migrationStatementTimeoutMs: 300_000,
    });
    const failed = res.failed.map((f) => f.file).sort();
    const detail = res.failed.map((f) => `${f.file}: ${String(f.error).split('\n')[0]}`).join('\n');
    expect(failed, detail).toEqual([...KNOWN_MANAGED_PG_GAPS].sort());
    expect(res.appliedCount).toBe(res.totalKnown - KNOWN_MANAGED_PG_GAPS.length);
  }, 600_000);
});
