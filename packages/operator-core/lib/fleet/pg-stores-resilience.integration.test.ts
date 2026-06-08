/**
 * fleet/pg-stores — the resilience stores (tombstone GC, saga journal, governor
 * credits), proven against a REAL Postgres (testcontainer; Docker required).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/fleet/pg-stores-resilience.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { pgTombstoneStore, pgSagaJournal, pgGovernorStore } from './pg-stores';

const WS = 'ws-a';
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fleetres',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(`
          CREATE TABLE harness_shared.fleet_tombstones (
            workspace_id text NOT NULL, ref_kind text NOT NULL, ref_id text NOT NULL,
            reason text, deleted_by text, deleted_at timestamptz, gc_after timestamptz,
            restored_at timestamptz,
            PRIMARY KEY (workspace_id, ref_kind, ref_id)
          )`);
        await s.unsafe(`
          CREATE TABLE harness_shared.fleet_sagas (
            workspace_id text NOT NULL, saga_id text NOT NULL, name text, status text,
            steps jsonb, error text, updated_at timestamptz DEFAULT now(),
            PRIMARY KEY (workspace_id, saga_id)
          )`);
        await s.unsafe(`
          CREATE TABLE harness_shared.fleet_governor (
            workspace_id text NOT NULL, kind text NOT NULL, scope_key text NOT NULL,
            capacity numeric, refill_per_sec numeric, tokens numeric, updated_at timestamptz,
            cb_state text, cb_failures int, cb_threshold int, cb_cooldown_sec int, cb_opened_at timestamptz,
            credits int, credit_max int,
            PRIMARY KEY (workspace_id, kind, scope_key)
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.fleet_tombstones, harness_shared.fleet_sagas, harness_shared.fleet_governor`;
});

describe('pgTombstoneStore', () => {
  const store = () => pgTombstoneStore(sql);
  const ref = { workspaceId: WS, refKind: 'feature', refId: 'F-1' };

  it('upsert marks tombstoned; restore clears it (and is idempotent)', async () => {
    const s = store();
    await s.upsert(ref, { reason: 'dup', deletedBy: 'u1', deletedAtMs: Date.now(), gcAfterMs: Date.now() + 60_000 });
    expect(await s.isTombstoned(ref)).toBe(true);
    expect(await s.restore(ref)).toBe(true);
    expect(await s.isTombstoned(ref)).toBe(false);
    expect(await s.restore(ref)).toBe(false); // already restored
  });

  it('gcExpired deletes expired, unrestored rows and returns their refs', async () => {
    const s = store();
    const past = Date.now() - 60_000;
    await s.upsert({ workspaceId: WS, refKind: 'feature', refId: 'old' }, { reason: 'x', deletedBy: 'u', deletedAtMs: past, gcAfterMs: past });
    await s.upsert({ workspaceId: WS, refKind: 'feature', refId: 'fresh' }, { reason: 'x', deletedBy: 'u', deletedAtMs: Date.now(), gcAfterMs: Date.now() + 60_000 });
    const gced = await s.gcExpired({ workspaceId: WS });
    expect(gced).toEqual(['feature:old']);
    expect(await s.isTombstoned({ workspaceId: WS, refKind: 'feature', refId: 'fresh' })).toBe(true);
  });

  it('gcExpired honors a refKind filter', async () => {
    const s = store();
    const past = Date.now() - 60_000;
    await s.upsert({ workspaceId: WS, refKind: 'feature', refId: 'a' }, { reason: 'x', deletedBy: 'u', deletedAtMs: past, gcAfterMs: past });
    await s.upsert({ workspaceId: WS, refKind: 'plan', refId: 'b' }, { reason: 'x', deletedBy: 'u', deletedAtMs: past, gcAfterMs: past });
    const gced = await s.gcExpired({ workspaceId: WS, refKind: 'plan' });
    expect(gced).toEqual(['plan:b']);
  });
});

describe('pgSagaJournal', () => {
  it('creates a running saga then records its terminal status + steps', async () => {
    const j = pgSagaJournal(sql);
    await j.create({ workspaceId: WS, sagaId: 's1', name: 'deploy', steps: [{ name: 'a' }] as never });
    const [created] = await sql<{ status: string; name: string }[]>`SELECT status, name FROM harness_shared.fleet_sagas WHERE saga_id = 's1'`;
    expect(created.status).toBe('running');
    expect(created.name).toBe('deploy');

    await j.update({ workspaceId: WS, sagaId: 's1', steps: [{ name: 'a', done: true }] as never, status: 'compensated', error: 'boom' });
    const [updated] = await sql<{ status: string; error: string }[]>`SELECT status, error FROM harness_shared.fleet_sagas WHERE saga_id = 's1'`;
    expect(updated.status).toBe('compensated');
    expect(updated.error).toBe('boom');
  });
});

describe('pgGovernorStore — credits', () => {
  it('configure + grant caps at credit_max, and a transaction can consume', async () => {
    const g = pgGovernorStore(sql);
    await g.configureCredits({ workspaceId: WS, scopeKey: 'gpu', credits: 5, max: 10 });

    expect(await g.grantCredits({ workspaceId: WS, scopeKey: 'gpu', n: 3 })).toBe(8); // 5+3
    expect(await g.grantCredits({ workspaceId: WS, scopeKey: 'gpu', n: 5 })).toBe(10); // capped at max

    const before = await g.transaction(async (tx) => {
      const row = await tx.lockCredit(WS, 'gpu');
      await tx.consumeCredit(WS, 'gpu');
      return row!.credits;
    });
    expect(before).toBe(10);
    const [{ credits }] = await sql<{ credits: number }[]>`SELECT credits FROM harness_shared.fleet_governor WHERE scope_key = 'gpu'`;
    expect(Number(credits)).toBe(9); // consumed one
  });

  it('recordCircuitSuccess resets a circuit to closed', async () => {
    const g = pgGovernorStore(sql);
    await g.configureCircuit({ workspaceId: WS, scopeKey: 'api', threshold: 3, cooldownSec: 30 });
    await sql`UPDATE harness_shared.fleet_governor SET cb_state = 'open', cb_failures = 5 WHERE scope_key = 'api'`;
    await g.recordCircuitSuccess({ workspaceId: WS, scopeKey: 'api' });
    const [row] = await sql<{ cb_state: string; cb_failures: number }[]>`SELECT cb_state, cb_failures FROM harness_shared.fleet_governor WHERE scope_key = 'api'`;
    expect(row.cb_state).toBe('closed');
    expect(Number(row.cb_failures)).toBe(0);
  });
});
