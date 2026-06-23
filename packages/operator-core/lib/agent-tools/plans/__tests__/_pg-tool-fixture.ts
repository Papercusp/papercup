/**
 * _pg-tool-fixture.ts — shared wiring for the plans *.integration.test.ts files.
 *
 * NOT a test file (no `.integration.test.ts` suffix → the glob never collects
 * it). It points the plan tools' OWN connection (`getOrgPgApp()` /
 * `getOrgPg()`, resolved from env) at the integration-tier baseline schema DB
 * that `test/setup/baseline-schema.globalSetup.ts` stood up — the same DB the
 * other tool-suite integration tests `inject('baselineSchemaDsn')` against, but
 * here we drive it THROUGH the tools rather than with a raw client.
 *
 * The injected DSN connects as the container superuser (`it_admin`). The
 * globalSetup also created the `harness_app` (RLS-subject) + `harness_admin`
 * (superuser) roles with the fixed convention passwords, so we re-point:
 *   - HARNESS_DATABASE_URL        → harness_app:harness_app_pwd     (withWorkspace path)
 *   - HARNESS_ADMIN_DATABASE_URL  → harness_admin:harness_admin_pwd (admin path)
 * exactly as embedded-pg + the dev box wire them. `_resetForTests()` drops any
 * pool the tools cached from a prior URL so the next getOrgPg*() rebuilds.
 *
 * Plans live in `harness_shared.harness_plans` keyed by (workspace_id,
 * harness_slug, plan_slug); RLS isolates by `app.workspace_id`, which
 * `withWorkspace()` sets inside its transaction.
 */
import { inject } from 'vitest';
import postgres from 'postgres';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';

export interface PlanPgFixture {
  /** Admin (superuser, RLS-bypassing) client for seed/cleanup of the test DB. */
  admin: postgres.Sql;
  /** The workspace the tools read/write under (matches DEFAULT_WORKSPACE_ID). */
  workspaceId: string;
  /** Tear down: close the admin client + reset the tools' cached pools/env. */
  dispose: () => Promise<void>;
}

function withUser(dsn: string, user: string, password: string): string {
  const u = new URL(dsn);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Wire the plan tools at the injected baseline DB and hand back an admin client
 * for direct seed/cleanup. Call once in `beforeAll`.
 */
export async function setupPlanPgFixture(): Promise<PlanPgFixture> {
  const dsn = inject('baselineSchemaDsn');

  // Re-point the tools' app + admin connections (resolved from env) at the
  // baseline DB, then drop any cached pool + memoized URL so the next
  // getOrgPg*() call rebuilds against these URLs.
  //
  // The DSN points at a throwaway testcontainer with NO PgBouncer. On a SERVER-class host
  // (the dev box / a dedicated CI server) pgbouncerEnabled() derives ON from hostClass, so
  // getOrgPg()'s maybePgbouncer() would reroute these reads to 127.0.0.1:6432 — the WRONG
  // Postgres — tripping a FATAL 08P01 under transaction pooling. Force the kill-switch OFF +
  // skip PG discovery so getOrgPg honours the env DSN verbatim (mirrors _baseline-coord-fixture).
  const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.HARNESS_DATABASE_URL = withUser(dsn, 'harness_app', 'harness_app_pwd');
  process.env.HARNESS_ADMIN_DATABASE_URL = withUser(dsn, 'harness_admin', 'harness_admin_pwd');
  _resetUrlCacheForTests();
  await _resetForTests();

  const admin = postgres(withUser(dsn, 'harness_admin', 'harness_admin_pwd'), {
    max: 2,
    onnotice: () => {},
    connection: { search_path: 'harness_shared, papercusp_shared, public' },
  });

  const dispose = async () => {
    await admin.end({ timeout: 5 }).catch(() => {});
    delete process.env.HARNESS_DATABASE_URL;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await _resetForTests();
  };

  return { admin, workspaceId: 'default', dispose };
}

/**
 * Delete every test plan row (+ its revisions) for a harness so a run leaves no
 * trace. Scoped to the throwaway harness slug the test owns — never touches the
 * real papercup plan rows (different harness_slug / their own DB anyway).
 */
export async function cleanupPlans(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  await admin`
    DELETE FROM harness_shared.plan_revisions
     WHERE harness_slug = ${harnessSlug}
       AND plan_slug IN (
         SELECT plan_slug FROM harness_shared.harness_plans
          WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       )
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
  `;
}

/**
 * Register a throwaway harness in `harness_shared.projects` so the plan tools'
 * `resolvePlanScope` can resolve its workspace. Post-WI-148, a concrete (non-
 * papercup) slug that is NOT registered THROWS instead of silently defaulting to
 * 'default' (source.ts) — so a test that drives a plan tool against a `zzz-…`
 * harness must first register it, exactly as production does before any plan is
 * written for a harness. Idempotent; uses the slug as the id (unique per test).
 */
export async function registerHarnessProject(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.projects
      (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES
      (${harnessSlug}, ${harnessSlug}, 'active', ${harnessSlug}, ${workspaceId}, 0, 0)
    ON CONFLICT DO NOTHING
  `;
}

/** Seed a plan row directly (admin/bypass) so a read/lock test has content. */
export async function seedPlan(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  slug: string,
  content: string,
): Promise<void> {
  // A plan for a concrete harness is only resolvable if the harness is registered
  // in projects (WI-148 fail-loud) — seed that precondition alongside the row.
  await registerHarnessProject(admin, workspaceId, harnessSlug);
  await admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, origin)
    VALUES
      (${workspaceId}, ${harnessSlug}, ${slug}, ${content},
       md5(${content}), 1, 'local')
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE
      SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash
  `;
}
