/**
 * read-cursors.integration.test.ts — proves PgReadCursorStore.ackAndAdvance works
 * against the REAL getOrgPg()-class client (WI-7092 / EI-607).
 *
 * Before this fix, `ackAndAdvance`'s INSERT bound its `pending` column via
 * `sql.json(next)` — which THROWS on getOrgPg's client (a postgres-js dual-package
 * module-instance mismatch; see agent-insights/sql-json-throws-on-getorgpg-client).
 * `read-cursors.test.ts` only ever exercises `InMemoryReadCursorStore` (its own
 * header says the Pg store's live behavior was "verified... via psql round-trip, not
 * here") — so this write path had ZERO automated coverage and was silently broken in
 * production every time it ran: every real cursor-ack call threw, so the fleet-deltas
 * P-004 two-phase ack protocol never actually persisted a cursor row.
 *
 * This test env-routes the real getOrgPg() at a throwaway MIGRATED database (the
 * `hive-git-mode-gc-arming.integration.test.ts` / "serve-wiring" idiom) so the exact
 * production call path — including the dual-package hazard that makes `sql.json`
 * throw — is what's exercised, not a tolerant fixture client.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/read-cursors.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { getOrgPg } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same pattern as hive-git-mode-gc-arming.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { ackAndAdvance, clearReadCursor, resetReadCursorStore } from './read-cursors';

describe('read-cursors PgReadCursorStore (PG) — ackAndAdvance against the real getOrgPg client', () => {
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
  }, 120_000);

  afterEach(async () => {
    resetReadCursorStore();
    await db.adminSql.unsafe('TRUNCATE harness_shared.coord_read_cursors');
  });

  afterAll(async () => {
    process.env.HARNESS_DATABASE_URL = prevAppUrl;
    process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await db?.cleanup();
  });

  it('persists a real jsonb OBJECT (not a sql.json throw, not a string-scalar) on first call', async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    const r = await ackAndAdvance(owner, surface, { a: 1 });
    expect(r).toEqual({ committed: null, baseline: true });

    const { sql } = getOrgPg();
    const rows = await sql<Array<{ pending: unknown }>>`
      SELECT pending FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows).toHaveLength(1);
    // A pre-fix sql.json(next) bind either threw (nothing landed at all) or, had it
    // silently double-encoded, would read back as the STRING '{"a":1}' rather than
    // the object {a:1}. Assert the real, typed object shape lands.
    expect(rows[0].pending).toEqual({ a: 1 });
  });

  it("call N+1 promotes call N's pending -> committed against the real DB", async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    await ackAndAdvance(owner, surface, { state: 'N' });
    const r2 = await ackAndAdvance(owner, surface, { state: 'N+1' });
    expect(r2).toEqual({ committed: { state: 'N' }, baseline: false });

    const { sql } = getOrgPg();
    const rows = await sql<Array<{ committed: unknown; pending: unknown }>>`
      SELECT committed, pending FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows[0]).toEqual({ committed: { state: 'N' }, pending: { state: 'N+1' } });
  });

  it('clearReadCursor deletes the row via the real DB', async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    await ackAndAdvance(owner, surface, { a: 1 });
    await clearReadCursor(owner, surface);

    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT 1 FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows).toHaveLength(0);
  });
});
