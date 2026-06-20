/**
 * rls-coverage.integration.test.ts — the TENANCY-ISOLATION coverage guard for
 * the federated (peer-log) tables.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every workspace-scoped `harness_shared` table relies on Postgres RLS for
 * multi-tenant isolation: RLS ENABLED + a policy
 *   USING/WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
 * and the app connects as the non-superuser `harness_app` role (harness_admin is
 * BYPASSRLS). The sibling `apps/operator/test/rls-isolation.integration.test.ts`
 * proves the MECHANISM works — but on a SYNTHETIC `public.rls_demo` table. Its
 * own header records the original audit finding: "RLS was only ever asserted to
 * *exist* (a regex check that the migration declares policies), never that it
 * *works*." Neither the behavioral test nor the text regex proves that every REAL
 * federated table, in the migrated schema, actually has RLS enabled + a
 * workspace-isolation policy.
 *
 * That is a SILENT cross-tenant leak waiting to happen: a new federated table
 * (this was a live footgun authoring mig-317 / hive_policy — `ENABLE ROW LEVEL
 * SECURITY` + the policy were attached by hand) that ships its capture trigger
 * and projection but FORGETS `ENABLE ROW LEVEL SECURITY`, or attaches a policy
 * that is not workspace-scoped, would federate workspace A's rows and expose them
 * to workspace B's `harness_app` reads — and nothing in CI would fail. These
 * tables are the highest-stakes surface for this because they cross machines.
 *
 * WHY AN INTEGRATION TEST (not a parse of the DDL files)
 * -----------------------------------------------------
 * RLS state is the cumulative result of many migrations (ENABLE here, a policy
 * there, a later ALTER). Grepping DDL is exactly the brittle "asserted to exist"
 * check the audit flagged. Mirroring the federation-coverage guards, this migrates
 * an empty DB 000-baseline → head through the REAL runner and introspects
 * `pg_class.relrowsecurity` + `pg_policies`, so a new federated table that forgets
 * RLS trips it automatically.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For every CDC-captured federated table (`CDC_CAPTURED_TABLES`) that carries a
 * `workspace_id` column (the tenancy key):
 *   1. RLS is ENABLED (`pg_class.relrowsecurity`), and
 *   2. at least one policy's USING qual references `app.workspace_id` (a real
 *      workspace-isolation policy, not just any policy).
 * Any table failing either is named with the remediation. A workspace-scoped
 * federated table intentionally exempt must be listed in `RLS_EXEMPT` with a
 * reason — none is expected (every federated table is multi-tenant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

/**
 * Federated tables with a workspace_id column that DO NOT enforce workspace RLS
 * in the migrated schema, EACH with the reason / status.
 *
 * ⚠️ The entries below are NOT confirmed-safe exemptions — they are CANDIDATE
 * TENANCY GAPS this guard surfaced on first run (tagged `REVIEW(findings-rls-
 * coverage)`), allow-listed only so the guard is GREEN/CI-safe while an owner
 * decides. The discovery run found 8 federated, workspace-scoped tables with
 * `relrowsecurity = false` while ~85 sibling tables (incl.
 * harness_features_consolidated) DO carry the canonical workspace policy in
 * 000-baseline — most starkly, harness_features_consolidated HAS RLS but its
 * sibling harness_issues_consolidated does NOT. Whether each is a real
 * cross-tenant exposure depends on the access path (is it read via the
 * non-BYPASSRLS `harness_app` role, and do those queries always filter
 * workspace_id explicitly?), which is the open question for review. Resolve per
 * `shared-hive-release-testing/findings-rls-coverage.md`: federate the workspace
 * policy, or confirm intentionally-unprotected and drop the REVIEW tag. Removing
 * an entry that gains RLS is enforced by the stale-exemption test below.
 */
const RLS_EXEMPT: Record<string, string> = {
  harness_issues_consolidated:
    'REVIEW(findings-rls-coverage): sibling harness_features_consolidated HAS the workspace policy ' +
    '(000-baseline) — issues does not. Strongest asymmetry smell; likely a real gap.',
  coord_conversations: 'REVIEW(findings-rls-coverage): coordination table, workspace-scoped, no RLS in migrated schema.',
  coord_event_log: 'REVIEW(findings-rls-coverage): coordination event log, workspace-scoped, no RLS in migrated schema.',
  coord_threads: 'REVIEW(findings-rls-coverage): coordination threads, workspace-scoped, no RLS in migrated schema.',
  coord_thread_posts: 'REVIEW(findings-rls-coverage): coordination thread posts, workspace-scoped, no RLS in migrated schema.',
  engineer_issues: 'REVIEW(findings-rls-coverage): engineer issue lane, workspace-scoped, no RLS in migrated schema.',
  plan_item_assignments: 'REVIEW(findings-rls-coverage): plan-item assignment lane, workspace-scoped, no RLS in migrated schema.',
  contributor_usage_events:
    'REVIEW(findings-rls-coverage): append-only usage ledger; workspace_id added late (mig-301, which notes it ' +
    '"does not actually federate"). Lower risk but still unprotected; confirm intentional.',
};

/** The workspace-isolation predicate every tenancy policy carries. */
const WS_PREDICATE = 'app.workspace_id';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'rlscov',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('federated CDC tables — workspace RLS is enabled + policy present (tenancy-coverage guard)', () => {
  /** CDC tables that carry a workspace_id column (the tenancy key). */
  async function fedTablesWithWorkspaceId(): Promise<string[]> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND column_name = 'workspace_id'
         AND table_name = ANY(${sql.array(CDC_CAPTURED_TABLES as string[])})
    `;
    return rows.map((r) => r.table_name).sort();
  }

  /** relrowsecurity per harness_shared table. */
  async function rlsEnabled(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT c.relname AS table_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relkind = 'r' AND c.relrowsecurity
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  /** harness_shared tables with at least one policy whose USING qual is the
   *  workspace-isolation predicate (not merely *some* policy). */
  async function workspaceIsoPolicyTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ tablename: string }>>`
      SELECT DISTINCT tablename FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND (COALESCE(qual, '') LIKE ${'%' + WS_PREDICATE + '%'}
              OR COALESCE(with_check, '') LIKE ${'%' + WS_PREDICATE + '%'})
    `;
    return new Set(rows.map((r) => r.tablename));
  }

  it('sanity: a representative federated table reports RLS enabled', async () => {
    const enabled = await rlsEnabled();
    // hive_settings has carried workspace RLS since mig-186; if THIS is absent the
    // introspection/migration is broken, not the invariant.
    expect(enabled.has('hive_settings'), 'RLS introspection returned nothing — query/migration broken').toBe(true);
  });

  it('every workspace-scoped federated table has RLS ENABLED (except documented RLS_EXEMPT)', async () => {
    const scoped = await fedTablesWithWorkspaceId();
    const enabled = await rlsEnabled();
    const missing = scoped.filter((t) => !enabled.has(t) && !(t in RLS_EXEMPT)).sort();
    expect(
      missing,
      `Federated, workspace-scoped table(s) DO NOT have RLS enabled — a remote op for one ` +
        `workspace lands in a table any workspace's harness_app can read: a SILENT cross-tenant ` +
        `leak. Add 'ALTER TABLE harness_shared.<t> ENABLE ROW LEVEL SECURITY;' + the workspace ` +
        `policy in your migration (mirror mig-317/186), or add to RLS_EXEMPT with a reason. ` +
        `Missing RLS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every workspace-scoped federated table has a workspace-ISOLATION policy (not just any policy)', async () => {
    const scoped = await fedTablesWithWorkspaceId();
    const isoPolicy = await workspaceIsoPolicyTables();
    const missing = scoped.filter((t) => !isoPolicy.has(t) && !(t in RLS_EXEMPT)).sort();
    expect(
      missing,
      `Federated, workspace-scoped table(s) have no policy whose predicate references ` +
        `'${WS_PREDICATE}' — RLS may be enabled but NOT workspace-isolating (deny-all, or scoped ` +
        `on something else), which either breaks the app or fails to isolate. Add the canonical ` +
        `workspace policy (USING/WITH CHECK (workspace_id = current_setting('app.workspace_id', true))). ` +
        `Missing iso policy: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no RLS_EXEMPT entry is stale (still a federated, workspace-scoped table lacking RLS)', async () => {
    const scoped = new Set(await fedTablesWithWorkspaceId());
    const enabled = await rlsEnabled();
    const stale = Object.keys(RLS_EXEMPT)
      .filter((t) => !scoped.has(t) || enabled.has(t))
      .sort();
    expect(
      stale,
      `RLS_EXEMPT has stale entr(ies) — the table now has RLS (or is no longer a federated ` +
        `workspace-scoped table). Remove the dead exemption: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
