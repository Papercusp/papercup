/**
 * hive-wake-pg.integration.test.ts — autoloop-hive-operator-rebuild-2026-06-05 P0.
 *
 * Proves, against a real Postgres (testcontainer) with migration 158 applied +
 * the baseline `routines` table shape, that the self-declared wake round-trips:
 *   - declareHiveTimeWake: one-shot routine row (no cron) with the clamped
 *     explicit next_fire_at, payload {blueprintId:'coding'}, target system:blueprint-run.
 *   - listDueCronRoutines + claimDueRoutine: the one-shot is not-due in the
 *     future, due once past, DEACTIVATED on claim (no refire loop), and a
 *     second claim loses. A cron routine stays active and advances.
 *   - hive_wake state (migration 158): subscriptions + lastWakeAt round-trip.
 *
 * Mirrors curation-pg.integration.test.ts's testcontainer setup (mocks
 * `@papercusp/db-org` getOrgPg + `workspace-registry` activeWorkspaceId).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

const WS = 'ws-hivetest';
const SLUG = 'hive-test-harness';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { listDueCronRoutines } = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
const {
  declareHiveTimeWake,
  clearHiveTimeWake,
  getHiveTimeWake,
  readHiveWakeState,
  setHiveEventSubscriptions,
  setHiveCarryNote,
  getHiveCarryNote,
  recordHiveWake,
  HIVE_WAKE_ROUTINE_NAME,
} = await import('./wake');
const { claimDueRoutine } = await import('../harness/routines/claim');
const { _resetReactionsForTests } = await import('../events/registry');

let rootSql: postgres.Sql;
let dbName: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `hive_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  // The baseline `routines` shape (000-baseline.sql) — columns + the unique
  // constraint upsertRoutine's ON CONFLICT (install_slug, name) needs.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text NOT NULL PRIMARY KEY,
      install_slug text NOT NULL,
      name text NOT NULL,
      trigger_kind text NOT NULL,
      trigger_config jsonb NOT NULL,
      target_role text NOT NULL,
      payload_template jsonb,
      concurrency text DEFAULT 'queue' NOT NULL,
      catchup text DEFAULT 'skip-old' NOT NULL,
      active boolean DEFAULT true NOT NULL,
      last_fired_at timestamptz,
      next_fire_at timestamptz,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      metadata jsonb,
      workspace_id text NOT NULL,
      -- migration 323 (B-LOOP-1): the loop-recurrence columns upsertRoutine now
      -- INSERTs. Hand-rolled here like the sibling routines-runtime.integration
      -- schema; omitting them drifts this test from head and the INSERT fails
      -- (column reschedule_interval_sec ... does not exist).
      reschedule_interval_sec integer,
      target_owner_id text,
      CONSTRAINT routines_install_slug_name_key UNIQUE (install_slug, name)
    )
  `);
  // 158 creates the legacy `pot_wake` table; 198 renames it to `hive_wake`
  // (the unify-launch-mechanics pot→hive rename) — apply BOTH so the test DB
  // matches head, where readHiveWakeState('hive_wake') reads the renamed table.
  await rootSql.unsafe(readMigration('158-pot-wake-state.sql')).simple();
  await rootSql.unsafe(readMigration('198-rename-pot-wake-to-hive-wake.sql')).simple();
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  _resetReactionsForTests();
  await rootSql?.end({ timeout: 5 });
});

describe('declareHiveTimeWake (the one-shot time wake)', () => {
  it('writes a one-shot routine: no cron, explicit clamped next_fire_at, hive payload', async () => {
    const now = new Date();
    const requested = new Date(now.getTime() + 3600_000);
    const r = await declareHiveTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: requested, now });
    expect(r.clamped).toBe(false);
    expect(r.at).toEqual(requested);

    const rows = await rootSql<
      Array<{ trigger_config: Record<string, unknown>; target_role: string; payload_template: Record<string, unknown>; active: boolean; next_fire_at: Date }>
    >`SELECT trigger_config, target_role, payload_template, active, next_fire_at
        FROM harness_shared.routines WHERE install_slug = ${SLUG} AND name = ${HIVE_WAKE_ROUTINE_NAME}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect(rows[0].trigger_config.cron).toBeUndefined();
    expect(rows[0].target_role).toBe('system:blueprint-run');
    expect(rows[0].payload_template.blueprintId).toBe('coding');
    expect(new Date(rows[0].next_fire_at).getTime()).toBe(requested.getTime());
  });

  it('clamps a too-soon wake to now + floor', async () => {
    const now = new Date();
    const r = await declareHiveTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(now.getTime() - 1000),
      now,
    });
    expect(r.clamped).toBe(true);
    expect(r.at.getTime()).toBe(now.getTime() + 60_000);
  });

  it('is not due in the future; due + claimable once past; DEACTIVATED on claim (one-shot, no refire)', async () => {
    // Future wake: not in the due list.
    const due0 = await listDueCronRoutines(rootSql);
    expect(due0.some((r) => r.name === HIVE_WAKE_ROUTINE_NAME)).toBe(false);

    // Force it due (the tick's view once the wall clock passes next_fire_at).
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
                   WHERE install_slug = ${SLUG} AND name = ${HIVE_WAKE_ROUTINE_NAME}`;
    const due1 = await listDueCronRoutines(rootSql);
    const routine = due1.find((r) => r.name === HIVE_WAKE_ROUTINE_NAME);
    expect(routine).toBeDefined();

    // First claim wins and DEACTIVATES (one-shot).
    expect(await claimDueRoutine(rootSql, routine!)).toBe(true);
    const after = await rootSql<Array<{ active: boolean; next_fire_at: Date | null }>>`
      SELECT active, next_fire_at FROM harness_shared.routines
       WHERE install_slug = ${SLUG} AND name = ${HIVE_WAKE_ROUTINE_NAME}`;
    expect(after[0].active).toBe(false);
    expect(after[0].next_fire_at).toBeNull();

    // No refire loop: it is gone from the due list, and a second claim loses.
    const due2 = await listDueCronRoutines(rootSql);
    expect(due2.some((r) => r.name === HIVE_WAKE_ROUTINE_NAME)).toBe(false);
    expect(await claimDueRoutine(rootSql, routine!)).toBe(false);
  });

  it('a CRON routine stays active and advances on claim (regression guard)', async () => {
    const { upsertRoutine } = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
    const { computeNextFireAt } = await import('../harness/routines/cron');
    await upsertRoutine(
      rootSql,
      {
        workspaceId: WS,
        installSlug: SLUG,
        name: 'cron-regression',
        triggerKind: 'cron',
        triggerConfig: { cron: '0 */5 * * * *' },
        targetRole: 'system:git-sync',
        active: true,
      },
      computeNextFireAt,
    );
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
                   WHERE install_slug = ${SLUG} AND name = 'cron-regression'`;
    const due = await listDueCronRoutines(rootSql);
    const routine = due.find((r) => r.name === 'cron-regression');
    expect(routine).toBeDefined();
    expect(await claimDueRoutine(rootSql, routine!)).toBe(true);
    const after = await rootSql<Array<{ active: boolean; next_fire_at: Date | null }>>`
      SELECT active, next_fire_at FROM harness_shared.routines
       WHERE install_slug = ${SLUG} AND name = 'cron-regression'`;
    expect(after[0].active).toBe(true);
    expect(after[0].next_fire_at).not.toBeNull();
    expect(new Date(after[0].next_fire_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('re-declaring reactivates (upsert) and clearHiveTimeWake deletes the row (EI-1477)', async () => {
    const r = await declareHiveTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(Date.now() + 7200_000),
    });
    expect(r.clamped).toBe(false);
    let state = await getHiveTimeWake(rootSql, SLUG);
    expect(state?.active).toBe(true);

    // EI-1477: clearHiveTimeWake now DELETEs the row (not just deactivates) to avoid
    // zombie rows that collide with a subsequent UPSERT under concurrency.
    await clearHiveTimeWake(rootSql, SLUG);
    state = await getHiveTimeWake(rootSql, SLUG);
    expect(state).toBeNull(); // row is fully deleted, not just set inactive

    // Re-declaring after clear must succeed (no stale row to collide with).
    const r2 = await declareHiveTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(Date.now() + 3600_000),
    });
    state = await getHiveTimeWake(rootSql, SLUG);
    expect(state?.active).toBe(true);
    expect(r2.clamped).toBe(false);
  });

  it('EI-1477: repeat-declare in the same turn UPSERTs in place (no duplicate-key collision)', async () => {
    const t1 = new Date(Date.now() + 3600_000);
    await declareHiveTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: t1 });

    // Immediately re-declare with a later time — must UPSERT, not INSERT+collide.
    const t2 = new Date(Date.now() + 7200_000);
    const r2 = await declareHiveTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: t2 });
    expect(r2.at.getTime()).toBe(t2.getTime());

    // Exactly ONE routine row must exist (no duplicates from the second declare).
    const rows = await rootSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.routines
       WHERE install_slug = ${SLUG} AND name = ${HIVE_WAKE_ROUTINE_NAME}`;
    expect(rows[0].n).toBe(1);

    // The stored nextFireAt must reflect the SECOND (later) declare.
    const finalState = await getHiveTimeWake(rootSql, SLUG);
    expect(new Date(finalState!.nextFireAt!).getTime()).toBe(t2.getTime());
  });
});

describe('hive_wake state (migration 158)', () => {
  it('subscriptions + lastWakeAt round-trip per workspace', async () => {
    expect((await readHiveWakeState(WS)).subscriptions).toEqual([]);

    const n = await setHiveEventSubscriptions(WS, [
      { on: 'coord:escalate', note: 'integration round-trip' },
    ]);
    expect(n).toBe(1);

    const s1 = await readHiveWakeState(WS);
    expect(s1.subscriptions).toHaveLength(1);
    expect(s1.subscriptions[0].on).toBe('coord:escalate');
    expect(s1.declaredAt).toBeTypeOf('number');

    await recordHiveWake(WS);
    const s2 = await readHiveWakeState(WS);
    expect(s2.lastWakeAt).toBeTypeOf('number');
    expect(s2.subscriptions).toHaveLength(1); // merge, not clobber

    await setHiveEventSubscriptions(WS, []);
    expect((await readHiveWakeState(WS)).subscriptions).toEqual([]);
  });

  it('carry-note (P-015 / B-04) round-trips with replace-semantics, coexists with subscriptions', async () => {
    // Fresh: no carry-note.
    expect(await getHiveCarryNote(WS)).toBeNull();

    // Set one — round-trips via getHiveCarryNote and the raw state field.
    const stored = await setHiveCarryNote(WS, '  Mid-wave on plan-x; revisit when wi-101 lands.  ');
    expect(stored).toBe('Mid-wave on plan-x; revisit when wi-101 lands.'); // trimmed
    expect(await getHiveCarryNote(WS)).toBe('Mid-wave on plan-x; revisit when wi-101 lands.');
    expect((await readHiveWakeState(WS)).carryNote).toBe('Mid-wave on plan-x; revisit when wi-101 lands.');

    // Coexists with subscriptions — neither clobbers the other (merge).
    await setHiveEventSubscriptions(WS, [{ on: 'coord:escalate', note: 'x' }]);
    expect(await getHiveCarryNote(WS)).toBe('Mid-wave on plan-x; revisit when wi-101 lands.');
    expect((await readHiveWakeState(WS)).subscriptions).toHaveLength(1);

    // Replace-semantics: a new note replaces the old.
    await setHiveCarryNote(WS, 'New intention.');
    expect(await getHiveCarryNote(WS)).toBe('New intention.');

    // Empty / whitespace / undefined clears it (she carried nothing this wake).
    expect(await setHiveCarryNote(WS, '   ')).toBeNull();
    expect(await getHiveCarryNote(WS)).toBeNull();
    await setHiveCarryNote(WS, 'again');
    expect(await setHiveCarryNote(WS, undefined)).toBeNull();
    expect(await getHiveCarryNote(WS)).toBeNull();
    // Subscriptions survived all the carry-note churn.
    expect((await readHiveWakeState(WS)).subscriptions).toHaveLength(1);
  });
});
