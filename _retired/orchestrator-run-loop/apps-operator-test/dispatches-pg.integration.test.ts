/**
 * dispatches-pg.integration.test.ts — real-Postgres coverage for the
 * inter-harness dispatch audit log (P-008, Phase 1).
 *
 * recordDispatchPg is write-only (no reader), so reads are raw SQL. The notable
 * finding here: result_body has the SAME jsonb double-encode bug as
 * mission-state lanes (D-006) — confirming it's a bug *class*, not a one-off
 * (the in-module comment claiming postgres-js coerces the stringified body via
 * the column cast is wrong).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  DISPATCHES_DDL,
  recordDispatchPg,
  type DispatchesPgContext,
} from '../../../libs/papercusp/packages/orchestrator/src/dispatches-pg';

let db: FreshPgDb;
const mkCtx = (): DispatchesPgContext => ({
  pg: db.sql as unknown as DispatchesPgContext['pg'],
  workspaceId: `ws_${randomBytes(4).toString('hex')}`,
});

beforeAll(async () => {
  db = await createFreshPgDb('dp');
  await db.sql.unsafe(DISPATCHES_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('dispatches-pg against real Postgres', () => {
  it('records a dispatch with a null result body and the scalar columns persist', async () => {
    const c = mkCtx();
    await recordDispatchPg(c, 'parent', 'child', 'worker', null);
    const [row] = await db.sql<
      { parent_slug: string; child_slug: string; child_role: string | null; result_body: unknown }[]
    >`
      SELECT parent_slug, child_slug, child_role, result_body
        FROM harness_shared.harness_dispatches
       WHERE workspace_id = ${c.workspaceId}`;
    expect(row.parent_slug).toBe('parent');
    expect(row.child_slug).toBe('child');
    expect(row.child_role).toBe('worker');
    expect(row.result_body).toBeNull();
  });

  it('records multiple distinct dispatches into the audit log', async () => {
    const c = mkCtx();
    await recordDispatchPg(c, 'p', 'c1', 'worker', null);
    await recordDispatchPg(c, 'p', 'c2', 'validator', null);
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_dispatches
       WHERE workspace_id = ${c.workspaceId}`;
    expect(n).toBe(2);
  });

  // D-007 FIX VERIFIED: recordDispatchPg now uses sql.json (via pgJson), so an
  // object result_body lands as a real jsonb object and round-trips.
  it('round-trips an object result body as a jsonb object', async () => {
    const c = mkCtx();
    await recordDispatchPg(c, 'p', 'obj', 'worker', { ok: true, n: 1 });
    const [row] = await db.sql<{ jt: string | null; body: unknown }[]>`
      SELECT jsonb_typeof(result_body) AS jt, result_body AS body
        FROM harness_shared.harness_dispatches
       WHERE workspace_id = ${c.workspaceId} AND child_slug = 'obj'`;
    expect(row.jt).toBe('object');
    expect(row.body).toEqual({ ok: true, n: 1 });
  });
});
