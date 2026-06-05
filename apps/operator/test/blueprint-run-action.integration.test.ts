/**
 * P-021 / D-018 — real-Postgres coverage for the `system:blueprint-run` scheduler action.
 *
 * Asserts the acceptance: a `harness_shared.routines` row with target_role
 * `system:blueprint-run` dispatches (the way `routinesTick`'s routineFireImpl does — via the
 * system-action registry) to the handler, which creates a work-item / starts a blueprint run.
 * Also covers `materializeBlueprintTriggers` writing the routines rows.
 *
 * Mirrors blueprint-project-pg.integration.test.ts: a throwaway testcontainer DB with the
 * relevant tables created ad-hoc (the full migration set is exercised by
 * fresh-migrate.integration.test.ts). getOrgPg() — what the handler's work-item insert reads —
 * is pointed at this DB via HARNESS_ADMIN_DATABASE_URL + _resetForTests (the list-workspaces
 * integration pattern).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { _resetForTests } from '@papercusp/db-org';
import { getSystemAction, type SystemActionCtx } from '@papercusp/operator-core/lib/harness/routines/system-actions';
import { setBlueprintResolver, setBlueprintRunFire } from '@papercusp/operator-core/lib/blueprint/blueprint-run-action';
// Side-effect import: registers system:blueprint-run (the path routinesTick imports).
import '@papercusp/operator-core/lib/harness/routines/register-system-actions';
import { materializeBlueprintTriggers } from '@papercusp/operator-core/lib/blueprint/materialize-triggers';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

const WS = 'ws_test';
const coding = loadBuiltinBlueprint('coding').blueprint;
const research = (): Blueprint => ({ ...coding, workItem: { kind: 'research-task', idPrefix: 'R' } });

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `bpr_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // getOrgPg() opens with search_path [harness_shared, papercup_shared, public].
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS papercup_shared');

  // work_items BASE table (harness_features_consolidated) — the columns the action writes,
  // incl. P-020/mig-135's item_kind + payload. PK (harness_slug, feature_id).
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      harness_slug       text NOT NULL,
      feature_id         text NOT NULL,
      title              text,
      summary            text,
      status             text,
      attempts           bigint,
      item_kind          text NOT NULL DEFAULT 'feature',
      payload            jsonb,
      needs_human_review boolean,
      workspace_id       text NOT NULL,
      ts                 bigint,
      created_ts         bigint,
      updated_ts         bigint,
      PRIMARY KEY (harness_slug, feature_id)
    )
  `);

  // routines table (the relevant columns + the (install_slug, name) unique key).
  await sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id             text PRIMARY KEY,
      install_slug   text NOT NULL,
      name           text NOT NULL,
      trigger_kind   text NOT NULL,
      trigger_config jsonb NOT NULL,
      target_role    text NOT NULL,
      payload_template jsonb,
      concurrency    text NOT NULL DEFAULT 'queue',
      catchup        text NOT NULL DEFAULT 'skip-old',
      active         boolean NOT NULL DEFAULT true,
      last_fired_at  timestamptz,
      next_fire_at   timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      metadata       jsonb,
      workspace_id   text NOT NULL,
      UNIQUE (install_slug, name)
    )
  `);

  process.env.HARNESS_ADMIN_DATABASE_URL = u.toString();
  await _resetForTests();
}, 60_000);

afterAll(async () => {
  delete process.env.HARNESS_ADMIN_DATABASE_URL;
  await _resetForTests();
  setBlueprintResolver(null);
  setBlueprintRunFire(null);
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await sql`DELETE FROM harness_shared.routines`;
  setBlueprintResolver(null);
  setBlueprintRunFire(null);
});

const dispatch = (ctx: SystemActionCtx) => {
  // The exact fn routineFireImpl invokes for a `system:blueprint-run` target_role.
  const fn = getSystemAction('blueprint-run');
  if (!fn) throw new Error('system:blueprint-run not registered');
  return fn(ctx);
};

describe('materializeBlueprintTriggers', () => {
  it('writes a cron routine per schedule entry (target_role=system:blueprint-run, active, scoped)', async () => {
    const bp = {
      triggers: {
        schedule: [
          { cron: '0 0 9 * * *', action: 'system:blueprint-run' },
          { cron: '*/30 * * * * *', action: 'system:blueprint-run' },
        ],
      },
    };
    // No opts.sql → materialize uses its production path getOrgPg().sql (prepare:false),
    // which is what HARNESS_ADMIN_DATABASE_URL points at this test's DB. (A plain prepare:true
    // instance would double-encode `$N::jsonb` params — see the jsonb note in the action.)
    const rows = await materializeBlueprintTriggers('demo', bp, { workspaceId: WS });
    expect(rows.map((r) => r.name)).toEqual(['bp-schedule-0', 'bp-schedule-1']);

    const db = await sql<
      { name: string; target_role: string; trigger_config: { cron: string }; active: boolean; workspace_id: string; next_fire_at: Date | null }[]
    >`SELECT name, target_role, trigger_config, active, workspace_id, next_fire_at
        FROM harness_shared.routines WHERE install_slug='demo' ORDER BY name`;
    expect(db).toHaveLength(2);
    expect(db[0].target_role).toBe('system:blueprint-run');
    expect(db[0].trigger_config.cron).toBe('0 0 9 * * *');
    expect(db[0].active).toBe(true);
    expect(db[0].workspace_id).toBe(WS);
    expect(db[0].next_fire_at).not.toBeNull(); // a valid cron computed a due time
  });

  it('is idempotent on (install_slug, name) — re-materialize updates, not duplicates', async () => {
    const bp = { triggers: { schedule: [{ cron: '0 0 9 * * *', action: 'system:blueprint-run' }] } };
    await materializeBlueprintTriggers('demo', bp, { workspaceId: WS });
    await materializeBlueprintTriggers(
      'demo',
      { triggers: { schedule: [{ cron: '0 0 18 * * *', action: 'system:blueprint-run' }] } },
      { workspaceId: WS },
    );
    const rows = await sql<{ cron: string }[]>`
      SELECT trigger_config->>'cron' AS cron FROM harness_shared.routines WHERE install_slug='demo'`;
    expect(rows).toHaveLength(1); // upserted, not duplicated
    expect(rows[0].cron).toBe('0 0 18 * * *'); // retimed
  });

  it('returns [] and writes nothing for a blueprint with no triggers', async () => {
    const rows = await materializeBlueprintTriggers('demo', {}, { workspaceId: WS });
    expect(rows).toEqual([]);
    const db = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='demo'`;
    expect(db).toHaveLength(0);
  });
});

describe("system:blueprint-run fires through the routine dispatch path", () => {
  it("mode='work-item' creates a feature-kind work-item in the work_items base", async () => {
    setBlueprintResolver(async () => coding); // workItem.kind='feature', idPrefix='F'
    // Seed the routine (what routinesTick would list as due) — then dispatch its handler.
    await materializeBlueprintTriggers('demo', { triggers: { schedule: [{ cron: '0 0 9 * * *', action: 'system:blueprint-run' }] } }, { sql, workspaceId: WS });

    await dispatch({
      installSlug: 'demo',
      workspaceId: WS,
      triggerConfig: { cron: '0 0 9 * * *' },
      payloadTemplate: { mode: 'work-item', workItem: { title: 'Nightly sweep' } },
    });

    const rows = await sql<{ feature_id: string; title: string; status: string; item_kind: string; workspace_id: string }[]>`
      SELECT feature_id, title, status, item_kind, workspace_id
        FROM harness_shared.harness_features_consolidated WHERE harness_slug='demo'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Nightly sweep');
    expect(rows[0].status).toBe('todo');
    expect(rows[0].item_kind).toBe('feature');
    expect(rows[0].workspace_id).toBe(WS);
    expect(rows[0].feature_id.startsWith('F-SCHED-')).toBe(true);
  });

  it("mode='work-item' honors a non-feature kind + payload (item_kind + payload)", async () => {
    setBlueprintResolver(async () => research()); // kind='research-task', idPrefix='R'
    await dispatch({
      installSlug: 'demo',
      workspaceId: WS,
      triggerConfig: {},
      payloadTemplate: { mode: 'work-item', workItem: { id: 'R-001', title: 'Survey X', payload: { topic: 'X' } } },
    });
    const rows = await sql<{ feature_id: string; item_kind: string; payload: { topic: string } | null }[]>`
      SELECT feature_id, item_kind, payload
        FROM harness_shared.harness_features_consolidated WHERE harness_slug='demo'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].feature_id).toBe('R-001'); // explicit id honored
    expect(rows[0].item_kind).toBe('research-task');
    expect(rows[0].payload).toEqual({ topic: 'X' });
  });

  it("mode='work-item' is replay-safe for an explicit id (ON CONFLICT DO NOTHING)", async () => {
    setBlueprintResolver(async () => coding);
    const ctx: SystemActionCtx = {
      installSlug: 'demo',
      workspaceId: WS,
      triggerConfig: {},
      payloadTemplate: { mode: 'work-item', workItem: { id: 'F-FIXED', title: 'once' } },
    };
    await dispatch(ctx);
    await dispatch(ctx); // a durable-step replay
    const rows = await sql`SELECT 1 FROM harness_shared.harness_features_consolidated WHERE harness_slug='demo' AND feature_id='F-FIXED'`;
    expect(rows).toHaveLength(1); // not double-created
  });

  it("mode='run' (default) fires the blueprint's decider, creating no work-item", async () => {
    const fired: Array<{ role: string; installSlug: string }> = [];
    setBlueprintResolver(async () => coding); // decider='director'
    setBlueprintRunFire((input) => { fired.push(input); });

    await dispatch({ installSlug: 'demo', workspaceId: WS, triggerConfig: {}, payloadTemplate: null });

    expect(fired).toHaveLength(1);
    expect(fired[0].role).toBe('director');
    const wi = await sql`SELECT 1 FROM harness_shared.harness_features_consolidated WHERE harness_slug='demo'`;
    expect(wi).toHaveLength(0); // run mode touches no work-item table
  });
});
