/**
 * mission-state-pg.integration.test.ts — real-Postgres coverage for the
 * orchestrator's durable mission state (P-008, Phase 1).
 *
 * `harness_mission_state` is one row per (workspace, harness) holding the
 * "what happened this mission" facts: cost_warn_fired, ready_for_prod_at, and
 * the lanes JSONB. The module's correctness hinges on PG semantics the
 * makeMockPg unit tests can't exercise: each setter is an UPSERT that touches
 * ONLY its own column (ON CONFLICT DO UPDATE SET <col>), the JSONB lanes array
 * must round-trip, BIGINT timestamps must coerce to JS numbers, and
 * clearMissionStatePg must reset the sentinels while PRESERVING lanes. This
 * test runs the real functions against a throwaway testcontainer Postgres.
 *
 * setEscalationPg is intentionally NOT covered here — it writes to a different
 * table (harness_escalations), not harness_mission_state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  MISSION_STATE_DDL,
  readMissionState,
  setCostWarnFiredPg,
  readCostWarnFiredPg,
  setReadyForProdPg,
  clearMissionStatePg,
  persistLanesPg,
  type MissionStatePgContext,
} from '../../../libs/papercusp/packages/orchestrator/src/mission-state-pg';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

// Each test gets a fresh (workspace, harness) so they're independent on the
// shared row-per-(workspace,harness) table.
const mkCtx = (): MissionStatePgContext => ({
  pg: sql as unknown as MissionStatePgContext['pg'],
  workspaceId: `ws_${randomBytes(4).toString('hex')}`,
  harnessSlug: `h_${randomBytes(4).toString('hex')}`,
});

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `ms_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), {
    max: 4,
    onnotice: () => {},
    // Mirror production (connection.ts) faithfully: prepare:false changes how
    // postgres-js infers param types (it matters for the JSONB `lanes` insert,
    // which binds a JSON string into a jsonb column), and BIGINT → number.
    prepare: false,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(MISSION_STATE_DDL);
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('mission-state-pg against real Postgres', () => {
  it('returns EMPTY_STATE for a harness with no row', async () => {
    const ctx = mkCtx();
    expect(await readMissionState(ctx)).toEqual({
      costWarnFired: false,
      readyForProdAt: null,
      lanes: [],
    });
    expect(await readCostWarnFiredPg(ctx)).toBe(false);
  });

  it('upserts cost_warn_fired and reads it back', async () => {
    const ctx = mkCtx();
    await setCostWarnFiredPg(ctx);
    expect(await readCostWarnFiredPg(ctx)).toBe(true);
    expect((await readMissionState(ctx)).costWarnFired).toBe(true);
  });

  it('upserts ready_for_prod_at as a coerced number', async () => {
    const ctx = mkCtx();
    await setReadyForProdPg(ctx);
    const { readyForProdAt } = await readMissionState(ctx);
    expect(typeof readyForProdAt).toBe('number');
    expect(readyForProdAt as number).toBeGreaterThan(0);
  });

  it('each setter is a column-scoped UPSERT — sentinels do not clobber each other', async () => {
    const ctx = mkCtx();
    await setCostWarnFiredPg(ctx);
    await setReadyForProdPg(ctx);
    const st = await readMissionState(ctx);
    expect(st.costWarnFired).toBe(true);
    expect(typeof st.readyForProdAt).toBe('number');
  });

  it('clearMissionStatePg resets the sentinels', async () => {
    const ctx = mkCtx();
    await setCostWarnFiredPg(ctx);
    await setReadyForProdPg(ctx);
    await clearMissionStatePg(ctx);
    const st = await readMissionState(ctx);
    expect(st.costWarnFired).toBe(false);
    expect(st.readyForProdAt).toBeNull();
  });

  // D-007 FIX VERIFIED: persistLanesPg now uses sql.json (via pgJson), so lanes
  // land as a real jsonb array and round-trip. (Was the original tripwire.)
  it('round-trips the lanes JSONB array', async () => {
    const ctx = mkCtx();
    const lanes = [
      { id: 1, feature_id: 'F-001', started_at: 111 },
      { id: 2, feature_id: 'F-002', started_at: 222, finished_at: 333 },
    ];
    await persistLanesPg(ctx, lanes);
    const [row] = await sql<{ jt: string | null }[]>`
      SELECT jsonb_typeof(lanes) AS jt
        FROM harness_shared.harness_mission_state
       WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug}`;
    expect(row.jt).toBe('array');
    expect((await readMissionState(ctx)).lanes).toEqual(lanes);
  });

  it('clearMissionStatePg resets the sentinels but PRESERVES lanes', async () => {
    const ctx = mkCtx();
    await setCostWarnFiredPg(ctx);
    await setReadyForProdPg(ctx);
    await persistLanesPg(ctx, [{ id: 1, feature_id: 'F-keep', started_at: 1 }]);
    await clearMissionStatePg(ctx);
    const st = await readMissionState(ctx);
    expect(st.costWarnFired).toBe(false);
    expect(st.readyForProdAt).toBeNull();
    expect(st.lanes).toEqual([{ id: 1, feature_id: 'F-keep', started_at: 1 }]);
  });

  it('isolates state by (workspace, harness)', async () => {
    const a = mkCtx();
    const b = mkCtx();
    await setCostWarnFiredPg(a);
    expect(await readCostWarnFiredPg(a)).toBe(true);
    expect(await readCostWarnFiredPg(b)).toBe(false);
  });
});
