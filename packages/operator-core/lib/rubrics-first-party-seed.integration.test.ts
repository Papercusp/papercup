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
 *      pot-coordination-health row) is left byte-untouched by the seed.
 *   3. IDEMPOTENCE — re-arming the seed gate and re-reading creates no second row.
 *
 * Docker-gated (`*.integration.test.ts`); mirrors rubrics-seed.integration.test.ts's
 * db-org mock + createOrgTestDb harness.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithWorkspaceIfConcrete } from './workspace-als';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // The seed WRITES through proposeRubric → withPlanLock → withWorkspace; without
    // this mock the write escapes the testcontainer onto the real org PG (the
    // _org-test-db.ts-prescribed pattern — RLS-scoped app role inside a txn).
    withWorkspace: <T,>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
      h.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx);
      }) as Promise<T>,
  };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

/** The shipped first-party set (plan D-002): the in-repo rubrics/ content dirs. */
const FIRST_PARTY_IDS = ['fleet-execution-health', 'pot-coordination-health', 'su-agent-behavior'];

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
    // Fresh migrated DB: only the mig-338 pot-coordination-health row pre-exists.
    // In production the loadAllRubrics choke point auto-runs this on any rubrics
    // read; under vitest the auto-hook is guarded off (see loadAllRubrics), so the
    // test drives the seed explicitly.
    await rubrics.ensureFirstPartyRubricsSeeded();
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
    const hive = await rubrics.getRubric('pot-coordination-health');
    // mig 338's own identity, NOT the bundle owner — the seed skipped the existing id.
    expect(hive!.ratifiedBy).toBe('aviynw@gmail.com');
    expect(hive!.createdBy).not.toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
  });

  it('idempotence: re-arming the gate and re-seeding creates no duplicate rows', async () => {
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();
    const again = await rubrics.listRubrics({});
    for (const id of FIRST_PARTY_IDS) {
      expect(again.filter((r) => r.rubricId === id)).toHaveLength(1);
    }
  });

  it('reclaims a WEDGED seeder-owned row: NULLed template_data re-seeds on the next pass (WI-3617)', async () => {
    // The live wedge shape (2026-07-17): a seeder-owned row whose template_data was
    // lost (a body-only restore during DB recovery). It is invisible to reads
    // (planRowToRubric nulls it) yet its raw slug used to block its own re-seed forever.
    await h.sql`
      UPDATE harness_shared.harness_plans SET template_data = NULL
       WHERE plan_slug = 'su-agent-behavior' AND template = 'rubric'`;
    expect(await rubrics.getRubric('su-agent-behavior')).toBeNull();

    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();

    const healed = await rubrics.getRubric('su-agent-behavior');
    expect(healed, 'the wedged seeder-owned row must be re-seeded, not block forever').not.toBeNull();
    expect(healed!.criteria.length).toBeGreaterThan(0);
    expect(healed!.status).toBe('active');
    expect(healed!.createdBy).toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
    // Still exactly one row — reclaim is an in-place upsert, never a duplicate.
    const all = await rubrics.listRubrics({});
    expect(all.filter((r) => r.rubricId === 'su-agent-behavior')).toHaveLength(1);
  });
});

describe('identity package rubric pin through the existing seed decision', () => {
  it('makes pinned criteria gradeable and refuses a different pin over locally edited criteria', async () => {
    const rubricId = 'identity-pinned-rubric';
    const source = {
      rubricId,
      title: 'Pinned identity rubric',
      characteristic: 'selected identity behavior',
      description: 'Pinned by the selected identity.',
      ratingScale: ['pass', 'fail', 'unknown'],
      methodRef: null,
      criteria: [{
        key: 'correct', title: 'Correct behavior', model: 'The selected behavior works.',
        method: 'Check a real run.', driftMarkers: 'The real run fails.',
      }],
    };
    await rubrics.provisionPinnedRubric(source, 'default');
    const read = () => runWithWorkspaceIfConcrete('default', () => rubrics.getRubric(rubricId));
    expect(await read()).toMatchObject({
      status: 'active', createdBy: rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER,
      criteria: [{ key: 'correct', model: 'The selected behavior works.' }],
    });
    await rubrics.provisionPinnedRubric(source, 'default');

    await h.sql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{criteria,0,title}', '"Local revision"')
       WHERE workspace_id = 'default' AND plan_slug = ${rubricId} AND template = 'rubric'`;
    const changed = { ...source, criteria: [{ ...source.criteria[0]!, model: 'A newer package revision.' }] };
    await expect(rubrics.provisionPinnedRubric(changed, 'default'))
      .rejects.toThrow(/conflicts with the workspace rubric store/);
    expect((await read())?.criteria[0]?.title).toBe('Local revision');
  });
});

describe('EI-12932: first-party bundle content-drift auto-upgrade', () => {
  // Each test uses its OWN rubricId (this describe shares one real DB across tests, no
  // per-test reset) so one test's row can never leak state into another's assertions.
  let RUBRIC_ID = '';
  const originalEnv = process.env.PAPERCUSP_RUBRICS_DIR;
  let scratch: string | null = null;

  const c1 = {
    key: 'c1',
    title: 'Criterion one',
    model: 'how it should work',
    method: 'how to check',
    driftMarkers: 'what broken looks like',
  };
  const c2 = {
    key: 'c2',
    title: 'Criterion two (added in the bundle upgrade)',
    model: 'how it should work',
    method: 'how to check',
    driftMarkers: 'what broken looks like',
  };

  function writeBundleVersion(criteria: object[]): void {
    scratch = scratch ?? mkdtempSync(join(tmpdir(), 'rubric-upgrade-'));
    const dir = join(scratch, RUBRIC_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rubric.json'),
      JSON.stringify({
        rubricId: RUBRIC_ID,
        title: 'Test upgrade rubric',
        characteristic: 'test-upgrade',
        description: 'd',
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        methodRef: null,
        criteria,
        version: '0.1.0',
        source: 'first-party',
      }),
    );
    process.env.PAPERCUSP_RUBRICS_DIR = scratch;
  }

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PAPERCUSP_RUBRICS_DIR;
    else process.env.PAPERCUSP_RUBRICS_DIR = originalEnv;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it('upgrades an unmodified seeded row in place when the bundle changes, preserving ratifiedBy/status', async () => {
    RUBRIC_ID = 'test-upgrade-rubric-1';
    writeBundleVersion([c1]);
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();

    const v1 = await rubrics.getRubric(RUBRIC_ID);
    expect(v1, 'v1 must seed').not.toBeNull();
    expect(v1!.criteria.map((c) => c.key)).toEqual(['c1']);
    expect(v1!.createdBy).toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);

    // Simulate a human setting ratifiedBy directly on the stored template_data (the
    // plans:set-template-data path — a raw jsonb patch that never touches the plan
    // owner column), WITHOUT touching the bundle-tracked fields. (releaseGating is
    // deliberately not exercised here — it requires an instrumentKey per criterion, a
    // field the bundle format doesn't carry at all; out of scope for this fix.)
    await h.sql`
      UPDATE harness_shared.harness_plans
         SET template_data = template_data || '{"ratifiedBy": "reviewer@x"}'::jsonb
       WHERE plan_slug = ${RUBRIC_ID} AND template = 'rubric'`;
    const patched = await rubrics.getRubric(RUBRIC_ID);
    expect(patched!.ratifiedBy).toBe('reviewer@x');

    // Now the bundle ships a v2: an added criterion, nothing else touched.
    writeBundleVersion([c1, c2]);
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();

    const v2 = await rubrics.getRubric(RUBRIC_ID);
    expect(v2!.criteria.map((c) => c.key), 'the upgrade must reach the store').toEqual(['c1', 'c2']);
    expect(v2!.status).toBe('active');
    expect(v2!.createdBy).toBe(rubrics.FIRST_PARTY_RUBRIC_SEED_OWNER);
    // The provenance the bundle never carries survives the whole-document upgrade.
    expect(v2!.ratifiedBy, 'ratifiedBy must survive the auto-upgrade').toBe('reviewer@x');

    // Still exactly one row — an upgrade is an in-place upsert, never a duplicate.
    const all = await rubrics.listRubrics({});
    expect(all.filter((r) => r.rubricId === RUBRIC_ID)).toHaveLength(1);

    // Idempotent: re-running against the now-current bundle makes no further write.
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();
    const v2Again = await rubrics.getRubric(RUBRIC_ID);
    expect(v2Again!.criteria.map((c) => c.key)).toEqual(['c1', 'c2']);
  });

  it('never overwrites a row that diverged from its own recorded seed state, even under the seed owner', async () => {
    RUBRIC_ID = 'test-upgrade-rubric-2';
    writeBundleVersion([c1]);
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();
    expect((await rubrics.getRubric(RUBRIC_ID))!.criteria.map((c) => c.key)).toEqual(['c1']);

    // Simulate the amendRubric-without-`by` edge case: a genuine local edit to c1's title
    // lands under the SAME seed owner identity, but seedContentHash is left stale (still
    // reflecting the pre-edit content) — exactly what a raw template_data patch (or a
    // future amend bug) would produce.
    await h.sql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{criteria,0,title}', '"a human retitled this"')
       WHERE plan_slug = ${RUBRIC_ID} AND template = 'rubric'`;
    const divergedTitle = (await rubrics.getRubric(RUBRIC_ID))!.criteria[0]!.title;
    expect(divergedTitle).toBe('a human retitled this');

    // The bundle now ships a v2 (an added criterion) — but the row's live content no
    // longer matches what the seeder last recorded, so the auto-upgrade must not fire.
    writeBundleVersion([c1, c2]);
    rubrics.__resetRubricSeedStateForTests();
    await rubrics.ensureFirstPartyRubricsSeeded();

    const stillDiverged = await rubrics.getRubric(RUBRIC_ID);
    expect(stillDiverged!.criteria.map((c) => c.key), 'the diverged row must be left untouched').toEqual(['c1']);
    expect(stillDiverged!.criteria[0]!.title, 'the local edit must survive').toBe('a human retitled this');
  });
});
