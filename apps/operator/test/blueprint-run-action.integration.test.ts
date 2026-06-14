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
import {
  materializeBlueprintTriggers,
  SINGLETON_TRIGGER_HOST_SLUG,
} from '@papercusp/operator-core/lib/blueprint/materialize-triggers';
import {
  materializeLearningSingletons,
  cutoverActiveLearningSingleton,
} from '@papercusp/operator-core/lib/blueprint/seed-learning-singletons';

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

  // autoloop_state — the P-009 fire-backoff gate reads this before a mode='run'
  // decider fire (checkFireGate → readFireState). A real baseline table; without
  // it the gate fail-opens with a console.warn that trips fail-on-console.
  await sql.unsafe(`
    CREATE TABLE harness_shared.autoloop_state (
      harness_slug       text NOT NULL,
      role               text NOT NULL DEFAULT 'director',
      last_fired_at      timestamptz NOT NULL DEFAULT now(),
      last_status        text,
      consecutive_errors integer NOT NULL DEFAULT 0,
      workspace_id       text NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, harness_slug, role)
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

describe('materializeBlueprintTriggers — workspace-singleton triggers (D-018)', () => {
  it('writes ONE dark routine under the reserved host-slug, named blueprint-uniquely', async () => {
    const bp = {
      id: 'regret',
      triggers: { schedule: [{ cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }] },
    };
    const rows = await materializeBlueprintTriggers('regret-harness', bp, { workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].singleton).toBe(true);
    expect(rows[0].name).toBe('bp-singleton-regret-0');
    expect(rows[0].hostSlug).toBe(SINGLETON_TRIGGER_HOST_SLUG);

    // It landed under the reserved slug, NOT the real install slug, and seeded INACTIVE/dark.
    const underReal = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='regret-harness'`;
    expect(underReal).toHaveLength(0);
    const db = await sql<
      { name: string; active: boolean; workspace_id: string; target_role: string; payload_template: { blueprintId?: string } | null }[]
    >`
      SELECT name, active, workspace_id, target_role, payload_template
        FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(db).toHaveLength(1);
    expect(db[0].name).toBe('bp-singleton-regret-0');
    expect(db[0].active).toBe(false); // dark — armed explicitly, not on install
    expect(db[0].workspace_id).toBe(WS);
    expect(db[0].target_role).toBe('system:blueprint-run');
    // It names its blueprint in the payload — a harness-less singleton row can't resolve the
    // blueprint any other way; system:blueprint-run reads payload_template.blueprintId.
    expect(db[0].payload_template?.blueprintId).toBe('regret');
  });

  it('is workspace-singleton: re-installing the blueprint upserts the SAME one row', async () => {
    const bp = {
      id: 'regret',
      triggers: { schedule: [{ cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }] },
    };
    // Two distinct installs of the same blueprint (different real slugs) → still ONE row.
    await materializeBlueprintTriggers('regret-harness-a', bp, { workspaceId: WS });
    await materializeBlueprintTriggers('regret-harness-b', bp, { workspaceId: WS });
    const db = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(db).toHaveLength(1); // not N-duplicated across installs
  });

  it('two different singleton blueprints get two distinct rows (name embeds the id)', async () => {
    await materializeBlueprintTriggers(
      'h1',
      { id: 'regret', triggers: { schedule: [{ cron: 'a', action: 'system:blueprint-run', singleton: true }] } },
      { workspaceId: WS },
    );
    await materializeBlueprintTriggers(
      'h2',
      { id: 'negative-space', triggers: { schedule: [{ cron: 'b', action: 'system:blueprint-run', singleton: true }] } },
      { workspaceId: WS },
    );
    const names = await sql<{ name: string }[]>`
      SELECT name FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG} ORDER BY name`;
    expect(names.map((r) => r.name)).toEqual(['bp-singleton-negative-space-0', 'bp-singleton-regret-0']);
  });

  it('mixes per-install (active, real slug) and singleton (dark, reserved slug) in one blueprint', async () => {
    const bp = {
      id: 'mixed',
      triggers: {
        schedule: [
          { cron: '0 0 9 * * *', action: 'system:blueprint-run' }, // per-install
          { cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }, // singleton
        ],
      },
    };
    const rows = await materializeBlueprintTriggers('mixed-harness', bp, { workspaceId: WS });
    expect(rows).toHaveLength(2);

    const perInstall = await sql<{ active: boolean }[]>`
      SELECT active FROM harness_shared.routines WHERE install_slug='mixed-harness'`;
    expect(perInstall).toHaveLength(1);
    expect(perInstall[0].active).toBe(true); // per-install seeded ACTIVE

    const singleton = await sql<{ name: string; active: boolean }[]>`
      SELECT name, active FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(singleton).toHaveLength(1);
    expect(singleton[0].name).toBe('bp-singleton-mixed-1');
    expect(singleton[0].active).toBe(false); // singleton seeded DARK
  });

  it('PILOT (P-144): the real `graduation` blueprint materializes one dark @singleton row carrying its blueprintId', async () => {
    // The built-in graduation blueprint now declares `singleton: true` on its schedule
    // trigger (the P-144 pilot). Materializing it must produce exactly the row that replaces
    // the bespoke seed-graduation-routine.ts: one @singleton dark row, named blueprint-uniquely,
    // stamped { blueprintId: 'graduation' } so the harness-less row fires the graduation program.
    const graduation = loadBuiltinBlueprint('graduation').blueprint;
    expect(graduation.triggers?.schedule?.[0]?.singleton).toBe(true); // the yaml declares it

    const rows = await materializeBlueprintTriggers(graduation.id, graduation, { workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].singleton).toBe(true);
    expect(rows[0].name).toBe('bp-singleton-graduation-0');
    expect(rows[0].hostSlug).toBe(SINGLETON_TRIGGER_HOST_SLUG);

    const db = await sql<
      { name: string; active: boolean; target_role: string; concurrency: string; trigger_config: { cron: string }; payload_template: { blueprintId?: string } | null }[]
    >`SELECT name, active, target_role, concurrency, trigger_config, payload_template
        FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(db).toHaveLength(1);
    expect(db[0].active).toBe(false); // dark — armed by the owner, not on materialize
    expect(db[0].target_role).toBe('system:blueprint-run');
    expect(db[0].trigger_config.cron).toBe('0 5 4 * * *'); // byte-identical cadence to the seed
    expect(db[0].payload_template?.blueprintId).toBe('graduation');
    expect(db[0].concurrency).toBe('skip'); // matches the bespoke seeds (a slow tick must not pile up)
  });

  it('singletonActive (D-024): an always-on singleton seeds ACTIVE on first creation', async () => {
    const rows = await materializeBlueprintTriggers('change-ledger', {
      id: 'change-ledger',
      triggers: { schedule: [{ cron: '0 20 * * * *', action: 'system:blueprint-run', singleton: true, singletonActive: true }] },
    }, { workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('bp-singleton-change-ledger-0');
    const db = await sql<{ active: boolean }[]>`
      SELECT active FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG} AND name='bp-singleton-change-ledger-0'`;
    expect(db[0].active).toBe(true); // always-on loop is live out-of-the-box, not dark
  });

  it('re-run safe (D-023): re-materializing an ARMED singleton preserves active + owner tuning', async () => {
    const bp = {
      id: 'regret',
      triggers: { schedule: [{ cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }] },
    };
    // First materialize (dark), then simulate the owner arming it + adding a tuning payload.
    await materializeBlueprintTriggers('regret', bp, { workspaceId: WS });
    await sql`
      UPDATE harness_shared.routines
         SET active = true,
             payload_template = payload_template || ${JSON.stringify({ payload: { budgetUsd: 5 } })}::text::jsonb
       WHERE install_slug = ${SINGLETON_TRIGGER_HOST_SLUG} AND name = 'bp-singleton-regret-0'`;
    // Re-materialize (a re-install / deploy re-seed) — must NOT clobber the armed state.
    await materializeBlueprintTriggers('regret', bp, { workspaceId: WS });
    const rows = await sql<{ active: boolean; bp: string | null; tuning: string | null }[]>`
      SELECT active, payload_template->>'blueprintId' AS bp, payload_template->'payload'->>'budgetUsd' AS tuning
        FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG} AND name='bp-singleton-regret-0'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true); // NOT darkened by the re-run
    expect(rows[0].bp).toBe('regret'); // blueprintId still present
    expect(rows[0].tuning).toBe('5'); // owner tuning preserved (merged, not overwritten)
  });
});

describe('materializeLearningSingletons — the seed-replacement cutover (P-144)', () => {
  const seedLegacyGraduation = (active: boolean) => sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, active, workspace_id)
    VALUES ('rt_papercup_graduation-scan', 'papercup', 'graduation-scan', 'cron',
            ${JSON.stringify({ cron: '0 5 4 * * *' })}::text::jsonb, 'system:blueprint-run',
            ${JSON.stringify({ blueprintId: 'graduation' })}::text::jsonb, ${active}, ${WS})`;

  it('execute + retire-legacy: creates the dark @singleton row and deletes the DARK legacy papercup row', async () => {
    await seedLegacyGraduation(false); // the post-EI-498 live shape: dark, repointed to blueprint-run
    const res = await materializeLearningSingletons(sql, WS, { only: 'graduation', execute: true, retireLegacy: true });
    expect(res).toHaveLength(1);
    expect(res[0].declaresSingleton).toBe(true);
    expect(res[0].materialized?.[0]?.name).toBe('bp-singleton-graduation-0');
    expect(res[0].legacy.deleted).toBe(true);

    const sing = await sql<{ active: boolean; bp: string | null }[]>`
      SELECT active, payload_template->>'blueprintId' AS bp
        FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG} AND name='bp-singleton-graduation-0'`;
    expect(sing).toHaveLength(1);
    expect(sing[0].active).toBe(false); // dark
    expect(sing[0].bp).toBe('graduation'); // fires the right program
    const legacy = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='papercup' AND name='graduation-scan'`;
    expect(legacy).toHaveLength(0); // legacy retired
  });

  it('collision guard (D-023): SKIPS a loop whose legacy papercup row is ACTIVE — no dark @singleton dup', async () => {
    await seedLegacyGraduation(true); // an ACTIVE legacy row (an armed loop — the collision case)
    const res = await materializeLearningSingletons(sql, WS, { only: 'graduation', execute: true, retireLegacy: true });
    expect(res[0].skipped).toBe('legacy-active');
    expect(res[0].materialized).toBeUndefined(); // did NOT materialize a duplicate
    expect(res[0].legacy.deleted).toBe(false);
    // legacy untouched (still firing); NO @singleton row created beside it
    const legacy = await sql<{ active: boolean }[]>`
      SELECT active FROM harness_shared.routines WHERE install_slug='papercup' AND name='graduation-scan'`;
    expect(legacy).toHaveLength(1);
    expect(legacy[0].active).toBe(true);
    const sing = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(sing).toHaveLength(0); // the dark CLI created no duplicate beside the armed loop
  });

  it('dry-run writes nothing', async () => {
    await seedLegacyGraduation(false);
    const res = await materializeLearningSingletons(sql, WS, { only: 'graduation', execute: false, retireLegacy: true });
    expect(res[0].materialized).toBeUndefined();
    const sing = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(sing).toHaveLength(0); // nothing created
    const legacy = await sql`SELECT 1 FROM harness_shared.routines WHERE name='graduation-scan'`;
    expect(legacy).toHaveLength(1); // nothing deleted
  });
});

describe('cutoverActiveLearningSingleton — behavior-neutral active cutover (P-144 / D-023)', () => {
  const seedActiveLegacy = (active: boolean, payloadExtra: Record<string, unknown> = {}) => sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
       concurrency, catchup, active, last_fired_at, next_fire_at, workspace_id)
    VALUES ('rt_papercup_graduation-scan', 'papercup', 'graduation-scan', 'cron',
            ${JSON.stringify({ cron: '0 5 4 * * *' })}::text::jsonb, 'system:blueprint-run',
            ${JSON.stringify({ blueprintId: 'graduation', ...payloadExtra })}::text::jsonb,
            'skip', 'skip-old', ${active}, now(), now(), ${WS})`;

  it('copies an ACTIVE legacy → @singleton (active+tuning+timing preserved) and deletes the legacy, atomically', async () => {
    await seedActiveLegacy(true, { payload: { budgetUsd: 7 } });
    const r = await cutoverActiveLearningSingleton(sql, WS, { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' }, { execute: true });
    expect(r.cutOver).toBe(true);
    expect(r.singletonName).toBe('bp-singleton-graduation-0');

    const sing = await sql<{ active: boolean; bp: string | null; tuning: string | null; concurrency: string; nfa: Date | null }[]>`
      SELECT active, payload_template->>'blueprintId' AS bp, payload_template->'payload'->>'budgetUsd' AS tuning,
             concurrency, next_fire_at AS nfa
        FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG} AND name='bp-singleton-graduation-0'`;
    expect(sing).toHaveLength(1);
    expect(sing[0].active).toBe(true); // kept firing — no behavior change
    expect(sing[0].bp).toBe('graduation');
    expect(sing[0].tuning).toBe('7'); // owner tuning preserved
    expect(sing[0].concurrency).toBe('skip'); // copied verbatim
    expect(sing[0].nfa).not.toBeNull(); // cadence preserved
    const legacy = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='papercup' AND name='graduation-scan'`;
    expect(legacy).toHaveLength(0); // legacy retired in the SAME transaction (no firing gap, no dup)
  });

  it('SKIPS a DARK legacy row — that is the dark CLI\'s job', async () => {
    await seedActiveLegacy(false);
    const r = await cutoverActiveLearningSingleton(sql, WS, { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' }, { execute: true });
    expect(r.skipped).toBe('legacy-dark');
    expect(r.cutOver).toBe(false);
    const legacy = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='papercup' AND name='graduation-scan'`;
    expect(legacy).toHaveLength(1); // untouched
    const sing = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(sing).toHaveLength(0);
  });

  it('dry-run writes nothing', async () => {
    await seedActiveLegacy(true);
    const r = await cutoverActiveLearningSingleton(sql, WS, { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' }, { execute: false });
    expect(r.legacyActive).toBe(true);
    expect(r.cutOver).toBe(false);
    const legacy = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug='papercup' AND name='graduation-scan'`;
    expect(legacy).toHaveLength(1); // untouched
    const sing = await sql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${SINGLETON_TRIGGER_HOST_SLUG}`;
    expect(sing).toHaveLength(0); // nothing created
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
