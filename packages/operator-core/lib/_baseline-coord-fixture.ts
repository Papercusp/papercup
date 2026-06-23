/**
 * _baseline-coord-fixture.ts — shared wiring for the coordination-area
 * *.integration.test.ts files (BRIEF-test-coverage-fu-coordination-federation-area:
 * coord-inbox-bus producer, presence.sweepStalePresence, topics-feed).
 *
 * NOT a test file (no `.test.ts` suffix → the layered glob never collects it).
 * It points the coordination modules' OWN connections at the integration-tier
 * baseline-schema DB that `baseline-schema.globalSetup` stood up (the same DB the
 * plans/cross_harness suites `inject('baselineSchemaDsn')` against). Those modules
 * resolve their PG from env at call time:
 *   - getOrgPg()           — the peek / sweep / tag-enrich reads (harness_app)
 *   - getHarnessAdminUrl() — the coord-inbox-bus LISTEN connection  (harness_admin)
 * so we re-point both env URLs and drop every memoized URL/pool so the next call
 * rebuilds against the baseline DB.
 *
 * Mirrors agent-tools/plans/__tests__/_pg-tool-fixture.ts, adding the
 * embedded-pg-discovery URL-cache reset that the LISTEN resolver memoizes
 * separately from the db-org connection cache.
 *
 * The injected DSN connects as the container superuser (`it_admin`); the
 * globalSetup also created the convention `harness_app` (RLS-subject) +
 * `harness_admin` (superuser) roles, so we re-point exactly as embedded-pg + the
 * dev box wire them. The returned `admin` client (harness_admin, RLS-bypassing)
 * is for direct seed/cleanup of the shared coord tables.
 */
import { inject } from 'vitest';
import postgres from 'postgres';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (not re-exported from the index)
import { _resetUrlCacheForTests } from '../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from './embedded-pg-discovery';

export interface BaselineCoordFixture {
  /** Admin (superuser, RLS-bypassing) client for seed/cleanup of the shared coord tables. */
  admin: postgres.Sql;
  /** Tear down: close the admin client + reset every cached pool/URL the modules memoized. */
  dispose: () => Promise<void>;
}

function withUser(dsn: string, user: string, password: string): string {
  const u = new URL(dsn);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Re-point the coordination modules at the injected baseline DB + hand back an
 * admin client. Call once in `beforeAll`.
 */
export async function setupBaselineCoordFixture(): Promise<BaselineCoordFixture> {
  const dsn = inject('baselineSchemaDsn');

  // The injected DSN points at a throwaway testcontainer with NO PgBouncer in front. On a
  // SERVER-class host (the dev box / a dedicated CI server), pgbouncerEnabled() derives ON from
  // hostClass even with PAPERCUSP_PGBOUNCER unset — so getOrgPg()'s maybePgbouncer() would rewrite
  // these reads to 127.0.0.1:6432 (the box's pooler), connecting to the WRONG Postgres and tripping
  // a FATAL 08P01 (protocol violation) under transaction pooling. Force the kill-switch OFF + skip
  // PG discovery so getOrgPg honours the env DSN's host:port verbatim. (Same guard the
  // feature-content-federation integration test uses; the symptom is dev-box-only because CI hosts
  // are workstation-class, so the suite is green there and red here.)
  const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.HARNESS_DATABASE_URL = withUser(dsn, 'harness_app', 'harness_app_pwd');
  process.env.HARNESS_ADMIN_DATABASE_URL = withUser(dsn, 'harness_admin', 'harness_admin_pwd');
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();

  const admin = postgres(withUser(dsn, 'harness_admin', 'harness_admin_pwd'), {
    max: 4,
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
    _resetHarnessAdminUrlCacheForTests();
    await _resetForTests();
  };

  return { admin, dispose };
}
