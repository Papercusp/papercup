/**
 * saga.integration.test.ts — sagas + tombstones for destructive ops (P4, D-006).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Drives the REAL saga engine against
 * real Postgres: forward completion, failure → compensations in REVERSE, the durable
 * log, and the soft-delete/tombstone/deferred-GC cycle (incl. restore as a saga
 * compensation).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { runSaga, softDelete, restoreTombstone, isTombstoned, physicalGc } from './saga';

const SAGAS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.fleet_sagas (
    workspace_id text NOT NULL, saga_id text NOT NULL, name text NOT NULL,
    status text NOT NULL DEFAULT 'running', steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, saga_id))`;
const TOMBSTONES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.fleet_tombstones (
    workspace_id text NOT NULL, ref_kind text NOT NULL, ref_id text NOT NULL,
    reason text NOT NULL DEFAULT '', deleted_by text, deleted_at timestamptz NOT NULL DEFAULT now(),
    gc_after timestamptz NOT NULL, restored_at timestamptz,
    PRIMARY KEY (workspace_id, ref_kind, ref_id))`;

const WS = 'default';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('saga');
  await db.sql.unsafe(SAGAS_DDL);
  await db.sql.unsafe(TOMBSTONES_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.fleet_sagas, harness_shared.fleet_tombstones`; });

describe('saga — forward + compensation (D-006, real PG)', () => {
  it('runs all steps and records completed', async () => {
    const ran: string[] = [];
    const res = await runSaga(db.sql, {
      workspaceId: WS, name: 'deploy',
      steps: [
        { name: 's1', run: async () => { ran.push('s1'); return 1; } },
        { name: 's2', run: async () => { ran.push('s2'); return 2; } },
        { name: 's3', run: async () => { ran.push('s3'); return 3; } },
      ],
    });
    expect(res.status).toBe('completed');
    expect(ran).toEqual(['s1', 's2', 's3']);
    expect(res.results).toEqual([1, 2, 3]);
    expect(res.steps.every((s) => s.status === 'done')).toBe(true);
    const row = await db.sql<{ status: string }[]>`SELECT status FROM harness_shared.fleet_sagas WHERE saga_id=${res.sagaId}`;
    expect(row[0].status).toBe('completed');
  });

  it('on a step failure, compensates the completed steps in REVERSE', async () => {
    const events: string[] = [];
    const res = await runSaga(db.sql, {
      workspaceId: WS, name: 'risky',
      steps: [
        { name: 'a', run: async () => { events.push('run:a'); return 'A'; }, compensate: async (r) => { events.push(`comp:a(${r})`); } },
        { name: 'b', run: async () => { events.push('run:b'); return 'B'; }, compensate: async (r) => { events.push(`comp:b(${r})`); } },
        { name: 'c', run: async () => { events.push('run:c'); throw new Error('boom'); } },
      ],
    });
    expect(res.status).toBe('compensated');
    expect(res.failedStep).toBe('c');
    expect(res.error).toMatch(/boom/);
    // a, b ran; c failed; then b compensated, then a (reverse).
    expect(events).toEqual(['run:a', 'run:b', 'run:c', 'comp:b(B)', 'comp:a(A)']);
    const steps = res.steps;
    expect(steps.find((s) => s.name === 'a')?.status).toBe('compensated');
    expect(steps.find((s) => s.name === 'b')?.status).toBe('compensated');
    expect(steps.find((s) => s.name === 'c')?.status).toBe('failed');
    const row = await db.sql<{ status: string; error: string }[]>`SELECT status, error FROM harness_shared.fleet_sagas WHERE saga_id=${res.sagaId}`;
    expect(row[0].status).toBe('compensated');
    expect(row[0].error).toMatch(/boom/);
  });
});

describe('saga — tombstone / deferred-GC destructive op (D-006, real PG)', () => {
  it('soft-delete is logically reversible; physical GC waits for the grace window', async () => {
    const t = 10_000_000;
    await softDelete(db.sql, { workspaceId: WS, refKind: 'snapshot', refId: 'snap-1', graceSec: 3600, now: t });
    expect(await isTombstoned(db.sql, { workspaceId: WS, refKind: 'snapshot', refId: 'snap-1' })).toBe(true);

    // Within the grace window → GC removes nothing.
    expect(await physicalGc(db.sql, { workspaceId: WS, now: t + 1000 })).toEqual([]);
    // Past the grace window → GC returns the ref to physically destroy + removes the tombstone.
    expect(await physicalGc(db.sql, { workspaceId: WS, now: t + 3_600_001 })).toEqual(['snapshot:snap-1']);
    expect(await isTombstoned(db.sql, { workspaceId: WS, refKind: 'snapshot', refId: 'snap-1' })).toBe(false);
  });

  it('restore (compensation) un-tombstones so a later GC skips it', async () => {
    const t = 11_000_000;
    await softDelete(db.sql, { workspaceId: WS, refKind: 'work_item', refId: 'WI-9', graceSec: 60, now: t });
    expect(await restoreTombstone(db.sql, { workspaceId: WS, refKind: 'work_item', refId: 'WI-9' })).toBe(true);
    expect(await isTombstoned(db.sql, { workspaceId: WS, refKind: 'work_item', refId: 'WI-9' })).toBe(false);
    // Even well past the window, a restored tombstone is never GC'd.
    expect(await physicalGc(db.sql, { workspaceId: WS, now: t + 1_000_000 })).toEqual([]);
  });

  it('a saga makes a destructive delete compensable: a later failure restores the soft-delete', async () => {
    const ref = { workspaceId: WS, refKind: 'snapshot', refId: 'snap-2' };
    const res = await runSaga(db.sql, {
      workspaceId: WS, name: 'prune-snapshot',
      steps: [
        { name: 'tombstone', run: async () => { await softDelete(db.sql, { ...ref, graceSec: 3600 }); return ref; }, compensate: async () => { await restoreTombstone(db.sql, ref); } },
        { name: 'verify-elsewhere', run: async () => { throw new Error('peer rejected the prune'); } },
      ],
    });
    expect(res.status).toBe('compensated');
    // The soft-delete was rolled back — the object lives.
    expect(await isTombstoned(db.sql, ref)).toBe(false);
  });
});
