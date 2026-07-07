/**
 * rubrics-first-party-seed.integration.test.ts — the bundled first-party rubric SEED
 * (local-first-party-rubric-bundling-2026-07-07 P-003) against a real migrated DB.
 *
 * The templates-v1 design applied to rubrics, with the one structural difference: a
 * rubric IS a plan row (trend/ratify/scorecards key off the DB), so the bundled layer
 * (cupboard/rubric-store.ts, here the in-repo `rubrics/` dev fallback) SEEDS into the
 * workspace store on the first rubrics read. Verifies the three contract points:
 *   1. COLD START — a fresh install's first read seeds the shipped set ACTIVE
 *      (owner FIRST_PARTY_RUBRIC_SEED_OWNER), fixing the zero-rubrics fresh-DB state.
 *   2. NO-CLOBBER — an id that already exists in the workspace (the mig-338
 *      hive-coordination-health row) is left byte-untouched by the seed.
 *   3. IDEMPOTENCE — re-arming the seed gate and re-reading creates no second row.
 *
 * Docker-gated (`*.integration.test.ts`); mirrors rubrics-seed.integration.test.ts's
 * db-org mock + createOrgTestDb harness.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // The seed WRITES through proposeRubric → withPlanLock → withWorkspace; without
    // this mock the write escapes the testcontainer onto the real org PG (the
    // _org-test-db.ts-prescribed pattern — RLS-scoped app role inside a txn).
    withWorkspace: (ws: string, cb: (tx: postgres.Sql) => Promise<unknown>) =>
      h.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx);
      }),
  };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

/** The shipped first-party set (plan D-002): the in-repo rubrics/ content dirs. */
const FIRST_PARTY_IDS = ['fleet-execution-health', 'hive-coordination-health', 'su-agent-behavior'];

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  rubrics.__resetRubricSeedStateForTests();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('first-party rubric seed (bundled → workspace store, lazy on first read)', () => {
  it('cold start: the first read seeds the shipped set ACTIVE', async () => {
    // Fresh migrated DB: only the mig-338 hive-coordination-health row pre-exists.
    // This read triggers ensureFirstPartyRubricsSeeded (loadAllRubrics choke point).
    const all = await rubrics.listRubrics({});
    const byId = new Map(all.map((r) => [r.rubricId, r]));
    for (const id of FIRST_PARTY_IDS) {
      const r = byId.get(id);
      expect(r, `first-party rubric '${id}' must resolve after the seed`).toBeDefined();
      expect(r!.status).toBe('active'); // shipped ratified
      expect(r!.criteria.length).toBeGreaterThan(0);
    }
    // The two rows the seed authored carry the bundle owner...
    expect(byId.get('su-agent-behavior')!.createdBy).toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
    expect(byId.get('fleet-execution-health')!.createdBy).toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
    // ...and the su-agent-behavior methodRef runbook pointer survived the trip.
    expect(byId.get('su-agent-behavior')!.methodRef).toBe('su-agent-behavior');
  });

  it('no-clobber: the pre-existing mig-338 row is untouched by the seed', async () => {
    const hive = await rubrics.getRubric('hive-coordination-health');
    // mig 338's own identity, NOT the bundle owner — the seed skipped the existing id.
    expect(hive!.ratifiedBy).toBe('aviynw@gmail.com');
    expect(hive!.createdBy).not.toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
  });

  it('idempotence: re-arming the gate and re-reading creates no duplicate rows', async () => {
    rubrics.__resetRubricSeedStateForTests();
    const again = await rubrics.listRubrics({});
    for (const id of FIRST_PARTY_IDS) {
      expect(again.filter((r) => r.rubricId === id)).toHaveLength(1);
    }
  });
});
