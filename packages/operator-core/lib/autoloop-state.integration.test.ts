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
import { getTestPg } from '@papercusp/test-config';

const WS = 'ws-altest';
const SLUG = 'backoff-harness';
const ROLE = 'director';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { recordFire, readFireState, checkFireGate, resetFireErrors, getAutoLoopState } = await import('./autoloop');

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
  // The baseline autoloop_state shape (000-baseline.sql:573 + the PK at :3160).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.autoloop_state (
      harness_slug text NOT NULL,
      role text DEFAULT 'director' NOT NULL,
      last_fired_at timestamptz DEFAULT now() NOT NULL,
      last_status text,
      consecutive_errors integer DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      CONSTRAINT autoloop_state_pkey PRIMARY KEY (workspace_id, harness_slug, role)
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
