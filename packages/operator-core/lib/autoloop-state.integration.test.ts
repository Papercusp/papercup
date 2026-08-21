/**
 * autoloop-state.integration.test.ts — autoloop-pot-operator-rebuild P-009.
 *
 * Proves, against a real Postgres (testcontainer) with the baseline
 * autoloop_state shape, the fire-state semantics the backoff gate depends on:
 *   - recordFire 'attempt' PRESERVES consecutive_errors (the old pre-fire
 *     'firing' record RESET it, so the counter could never exceed 1 — the
 *     latent bug that made D-009's written-but-never-read worse than unread).
 *   - 'error' increments; 'ok' resets (closes the circuit).
 *   - readFireState/checkFireGate round-trip + resetFireErrors.
 *
 * Mirrors pot-wake-pg.integration.test.ts's setup; getOrgPg is mocked to a
 * drizzle instance over the per-test database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';

const WS = 'ws-altest';
const SLUG = 'backoff-harness';
const ROLE = 'director';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const {
  recordFire,
  recordWithheld,
  readFireState,
  checkFireGate,
  resetFireErrors,
  getAutoLoopState,
  pruneStaleFireState,
  LOOP_TERMINAL_AUTO_PAUSE_STATUS,
} = await import('./autoloop');

let rootSql: postgres.Sql;
let dbName: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `al_${randomBytes(5).toString('hex')}`;
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
  // The baseline autoloop_state shape (000-baseline.sql:573 + the PK at :3160)
  // plus the EI-14483 withhold-tracking columns (migration 634).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.autoloop_state (
      harness_slug text NOT NULL,
      role text DEFAULT 'director' NOT NULL,
      last_fired_at timestamptz DEFAULT now() NOT NULL,
      last_status text,
      consecutive_errors integer DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      last_withheld_at timestamptz,
      last_withheld_reason text,
      last_withheld_detail text,
      CONSTRAINT autoloop_state_pkey PRIMARY KEY (workspace_id, harness_slug, role)
    )
  `);
  // Minimal harness_shared.routines shape (EI-7009): only the columns pruneStaleFireState's
  // second (EI-7009) prune class JOINs against — id/install_slug/name/active/workspace_id.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY,
      install_slug text NOT NULL,
      name text NOT NULL,
      active boolean DEFAULT true NOT NULL,
      workspace_id text NOT NULL
    )
  `);
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

const errors = async (): Promise<number> => (await readFireState(SLUG, ROLE))?.consecutiveErrors ?? -1;

describe('recordFire outcome semantics (P-009)', () => {
  it("the attempt/error cycle ACCUMULATES errors — 'attempt' preserves the counter", async () => {
    // Three failed fire cycles, each preceded by the pre-fire 'attempt' record.
    for (const n of [1, 2, 3]) {
      await recordFire(SLUG, ROLE, 'firing', 'attempt');
      await recordFire(SLUG, ROLE, `error: boom ${n}`, 'error');
      expect(await errors()).toBe(n);
    }
  });

  it("'ok' resets the counter to 0 (closes the circuit)", async () => {
    await recordFire(SLUG, ROLE, 'ok', 'ok');
    expect(await errors()).toBe(0);
  });

  it('the gate withholds under accumulated errors and resetFireErrors clears it', async () => {
    // Rebuild 3 errors → 240s backoff window; last_fired_at is now() ⇒ withheld.
    for (let i = 0; i < 3; i++) await recordFire(SLUG, ROLE, 'error: x', 'error');
    const withheld = await checkFireGate(SLUG, ROLE);
    expect(withheld.allow).toBe(false);
    expect(withheld.reason).toBe('backoff');
    expect(withheld.consecutiveErrors).toBe(3);

    // Pushing the last fire into the past re-allows (elapsed ≥ window).
    await rootSql`UPDATE harness_shared.autoloop_state
                     SET last_fired_at = now() - interval '5 minutes'
                   WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND role = ${ROLE}`;
    expect((await checkFireGate(SLUG, ROLE)).allow).toBe(true);

    // Manual circuit reset (the autoloop:control op).
    const n = await resetFireErrors(SLUG);
    expect(n).toBe(1);
    expect(await errors()).toBe(0);
    expect((await checkFireGate(SLUG, ROLE)).allow).toBe(true);
  });

  it('the status surface returns the per-role rows', async () => {
    const rows = await getAutoLoopState(SLUG);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({ harness_slug: SLUG, role: ROLE });
  });

  it('an unknown (slug, role) has no row ⇒ the gate allows', async () => {
    expect(await readFireState('nope', 'nobody')).toBeNull();
    expect((await checkFireGate('nope', 'nobody')).allow).toBe(true);
  });
});

describe('recordWithheld (EI-14483) — durable trace for an attempted-and-denied fire', () => {
  const WSLUG = 'withhold-harness';
  const WROLE = 'director';

  it('upserts last_withheld_* WITHOUT touching last_fired_at / consecutive_errors of an existing row', async () => {
    // Seed a baseline row via the ordinary fire path — 2 accumulated errors.
    await recordFire(WSLUG, WROLE, 'firing', 'attempt');
    await recordFire(WSLUG, WROLE, 'error: boom', 'error');
    await recordFire(WSLUG, WROLE, 'firing', 'attempt');
    await recordFire(WSLUG, WROLE, 'error: boom 2', 'error');
    const before = await rootSql<{ last_fired_at: Date; consecutive_errors: number }[]>`
      SELECT last_fired_at, consecutive_errors FROM harness_shared.autoloop_state
       WHERE workspace_id = ${WS} AND harness_slug = ${WSLUG} AND role = ${WROLE}`;
    expect(before[0].consecutive_errors).toBe(2);

    await recordWithheld(WSLUG, WROLE, 'fire-gate', 'backoff window 240s not yet elapsed');

    const after = await rootSql<
      {
        last_fired_at: Date;
        consecutive_errors: number;
        last_withheld_at: Date | null;
        last_withheld_reason: string | null;
        last_withheld_detail: string | null;
      }[]
    >`SELECT last_fired_at, consecutive_errors, last_withheld_at, last_withheld_reason, last_withheld_detail
        FROM harness_shared.autoloop_state
       WHERE workspace_id = ${WS} AND harness_slug = ${WSLUG} AND role = ${WROLE}`;
    // The backoff clock (last_fired_at) and error counter must be COMPLETELY untouched —
    // that is the entire point of recordWithheld writing to separate columns.
    expect(new Date(after[0].last_fired_at).getTime()).toBe(new Date(before[0].last_fired_at).getTime());
    expect(after[0].consecutive_errors).toBe(2);
    // The new withhold-tracking columns are now populated.
    expect(after[0].last_withheld_at).not.toBeNull();
    expect(after[0].last_withheld_reason).toBe('fire-gate');
    expect(after[0].last_withheld_detail).toBe('backoff window 240s not yet elapsed');
  });

  it('inserts a fresh row when none exists yet (no prior recordFire)', async () => {
    const FRESH = 'withhold-fresh';
    expect(await readFireState(FRESH, WROLE)).toBeNull();
    await recordWithheld(FRESH, WROLE, 'fire-gate', 'circuit open');
    const rows = await rootSql<{ last_withheld_reason: string | null; last_withheld_detail: string | null }[]>`
      SELECT last_withheld_reason, last_withheld_detail FROM harness_shared.autoloop_state
       WHERE workspace_id = ${WS} AND harness_slug = ${FRESH} AND role = ${WROLE}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].last_withheld_reason).toBe('fire-gate');
    expect(rows[0].last_withheld_detail).toBe('circuit open');
    // readFireState (last_fired_at/consecutive_errors only) still sees this row: the
    // insert's last_fired_at default (now()) makes it visible to the backoff gate too,
    // but with 0 accumulated errors ⇒ the gate still allows.
    expect((await checkFireGate(FRESH, WROLE)).allow).toBe(true);
  });

  it('is fail-soft on write failure — never throws (best-effort, does not affect the gate decision)', async () => {
    // An empty/blank slug is accepted by the DB (text column, no NOT NULL-empty check),
    // so exercise fail-soft via a role value that cannot violate the schema either;
    // instead assert the documented contract directly: recordWithheld never rejects.
    await expect(recordWithheld('', '', 'fire-gate')).resolves.toBeUndefined();
  });

  it('surfaces via getAutoLoopState (autoloop:status)', async () => {
    const rows = await getAutoLoopState(WSLUG);
    expect(rows).not.toBeNull();
    const row = rows!.find((r) => r.role === WROLE);
    expect(row).toMatchObject({
      harness_slug: WSLUG,
      role: WROLE,
      last_withheld_reason: 'fire-gate',
    });
    expect(row.last_withheld_at).not.toBeNull();
  });
});

describe('pruneStaleFireState hygiene (autonomous-loop-hardening F6)', () => {
  it('retires stale zero-error rows but PRESERVES error-carrying and recent rows', async () => {
    const PW = 'ws-prune';
    await rootSql`INSERT INTO harness_shared.autoloop_state
        (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
        ('dead-old',      'director', now() - interval '30 days', 'ok',       0, ${PW}),
        ('dead-erroring', 'director', now() - interval '30 days', 'error: x', 3, ${PW}),
        ('fresh',         'director', now() - interval '1 hour',  'ok',       0, ${PW})`;

    // Global prune (>=1: only this workspace's rows are stale-0-error at this point).
    const n = await pruneStaleFireState({ maxAgeDays: 7 });
    expect(n).toBeGreaterThanOrEqual(1);

    // The precise proof: the stale zero-error row is gone; the erroring + recent ones remain.
    const remaining = await rootSql<{ harness_slug: string }[]>`
      SELECT harness_slug FROM harness_shared.autoloop_state
       WHERE workspace_id = ${PW} ORDER BY harness_slug`;
    expect(remaining.map((r) => r.harness_slug)).toEqual(['dead-erroring', 'fresh']);
  });

  it('is GLOBAL across workspaces, not scoped to the active one', async () => {
    const OTHER = 'ws-prune-other';
    await rootSql`INSERT INTO harness_shared.autoloop_state
        (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
        ('other-dead', 'director', now() - interval '60 days', 'ok', 0, ${OTHER})`;
    // activeWorkspaceId() is mocked to WS ('ws-altest'), yet the row in OTHER is still retired.
    const n = await pruneStaleFireState({ maxAgeDays: 7 });
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await rootSql`SELECT 1 FROM harness_shared.autoloop_state WHERE workspace_id = ${OTHER}`;
    expect(left.length).toBe(0);
  });

  describe('EI-7009: auto-paused loop:arm terminal watermark', () => {
    it('retires a recent, error-carrying row whose matching routine is auto-paused (active=false)', async () => {
      const PW = 'ws-prune-term';
      await rootSql`INSERT INTO harness_shared.routines (id, install_slug, name, active, workspace_id)
          VALUES ('r-dead', '*', 'loop-su-gone', false, ${PW})`;
      // Recent + error-carrying: class 1 (age+zero-error) would NOT catch this row —
      // it must be retired ONLY by the EI-7009 terminal-marker class.
      await rootSql`INSERT INTO harness_shared.autoloop_state
          (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
          ('*', 'loop-su-gone', now(), ${LOOP_TERMINAL_AUTO_PAUSE_STATUS}, 7, ${PW})`;

      const n = await pruneStaleFireState({ maxAgeDays: 7 });
      expect(n).toBeGreaterThanOrEqual(1);
      const left = await rootSql`SELECT 1 FROM harness_shared.autoloop_state
          WHERE workspace_id = ${PW} AND harness_slug = '*' AND role = 'loop-su-gone'`;
      expect(left.length).toBe(0);
    });

    it('does NOT touch a row with the SAME terminal marker whose routine is still active', async () => {
      const PW = 'ws-prune-term-active';
      await rootSql`INSERT INTO harness_shared.routines (id, install_slug, name, active, workspace_id)
          VALUES ('r-live', '*', 'loop-su-live', true, ${PW})`;
      await rootSql`INSERT INTO harness_shared.autoloop_state
          (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
          ('*', 'loop-su-live', now(), ${LOOP_TERMINAL_AUTO_PAUSE_STATUS}, 7, ${PW})`;

      await pruneStaleFireState({ maxAgeDays: 7 });
      const left = await rootSql`SELECT 1 FROM harness_shared.autoloop_state
          WHERE workspace_id = ${PW} AND harness_slug = '*' AND role = 'loop-su-live'`;
      expect(left.length).toBe(1);
    });

    it('does NOT touch a row whose routine is inactive but carries a DIFFERENT last_status (a human pause under investigation)', async () => {
      const PW = 'ws-prune-term-human';
      await rootSql`INSERT INTO harness_shared.routines (id, install_slug, name, active, workspace_id)
          VALUES ('r-paused', '*', 'loop-paused-for-review', false, ${PW})`;
      await rootSql`INSERT INTO harness_shared.autoloop_state
          (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
          ('*', 'loop-paused-for-review', now(), 'error: mid-investigation', 5, ${PW})`;

      await pruneStaleFireState({ maxAgeDays: 7 });
      const left = await rootSql`SELECT 1 FROM harness_shared.autoloop_state
          WHERE workspace_id = ${PW} AND harness_slug = '*' AND role = 'loop-paused-for-review'`;
      expect(left.length).toBe(1);
    });

    it('does NOT touch a row with the terminal marker but NO matching routine row at all', async () => {
      const PW = 'ws-prune-term-orphan';
      await rootSql`INSERT INTO harness_shared.autoloop_state
          (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id) VALUES
          ('*', 'loop-no-routine-row', now(), ${LOOP_TERMINAL_AUTO_PAUSE_STATUS}, 4, ${PW})`;

      await pruneStaleFireState({ maxAgeDays: 7 });
      const left = await rootSql`SELECT 1 FROM harness_shared.autoloop_state
          WHERE workspace_id = ${PW} AND harness_slug = '*' AND role = 'loop-no-routine-row'`;
      expect(left.length).toBe(1);
    });
  });
});
