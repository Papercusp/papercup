/** EI-24791346664119438: real producer/store/reconciler correlation before transcript ingest. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { recordLoopTurnStart } from './loop-turn-start-stamp';
import { reconcileLoopRoutines } from './reconcile-loop-routines';
import { LOOP_TURN_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';

let pg: DedicatedNativePg;
let org: OrgTestDb;
let sql: Sql;
const savedAdmin = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
const WS = 'ws-loop-start-correlation';

beforeAll(async () => {
  // This acceptance owns its cluster: no live workspace or shared baseline mutex.
  pg = await startDedicatedNativePg();
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 180_000);

afterAll(async () => {
  try {
    await org?.cleanup();
  } finally {
    await pg?.stop();
    if (savedAdmin === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdmin;
  }
});

afterEach(() => vi.restoreAllMocks());

describe('loop turn-start producer to reconciler, real Postgres', () => {
  it('holds the stamped running turn past delivery grace and retries the unstamped control', async () => {
    const now = Date.now();
    const fired = new Date(now - 10_000);
    const dispatched = new Date(now - 5_000);
    const cases = [
      { id: 'rt-start-proof', owner: 'su-start-proof', stamped: true },
      { id: 'rt-no-start-proof', owner: 'su-no-start-proof', stamped: false },
    ];
    for (const c of cases) {
      await sql`
        INSERT INTO harness_shared.routines
          (id, install_slug, name, trigger_kind, trigger_config, target_role,
           active, workspace_id, last_fired_at, next_fire_at,
           reschedule_interval_sec, target_owner_id)
        VALUES (${c.id}, 'papercusp', ${c.id}, 'cron', '{}'::jsonb, 'su',
                TRUE, ${WS}, ${fired}, 'infinity'::timestamptz, 60, ${c.owner})`;
      const awaits = await sql<Array<{ id: number }>>`
        INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
        VALUES (${WS}, ${c.owner}, ${'test:' + c.id}) RETURNING id`;
      await sql`
        INSERT INTO harness_shared.event_wake_deliveries
          (workspace_id, await_id, subscriber_id, event_key, source, status,
           channel, created_at, delivered_at)
        VALUES (${WS}, ${awaits[0]!.id}, ${c.owner}, ${'test:' + c.id},
                ${'loop:' + c.id}, 'delivered', 'psu-socket-inject', ${dispatched}, ${dispatched})`;
      // Exercise the real producer and default PG telemetry writer, not a seeded marker.
      expect(await recordLoopTurnStart({
        owner: c.owner, workspaceId: WS, client: 'codex',
        prompt: c.stamped
          ? '⟦turn-origin:loop-fire nonce:8ed10949adab325d⟧\nContinue the loop.'
          : 'An unrelated owner turn.',
      })).toBe(c.stamped);
    }

    const stamps = await sql<Array<{ owner_id: string; created_at: Date; summary: string }>>`
      SELECT owner_id, created_at, summary FROM harness_shared.agent_activity
       WHERE workspace_id = ${WS}`;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ owner_id: 'su-start-proof', summary: LOOP_TURN_START_MARKER });
    expect(stamps[0]!.created_at.getTime()).toBeGreaterThan(dispatched.getTime());

    const recordFire = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileLoopRoutines({
      sql, nowMs: now + 3 * 60_000,
      recordFire, readFireState: async () => null,
    });
    const rows = await sql<Array<{ id: string; parked: boolean }>>`
      SELECT id, next_fire_at = 'infinity'::timestamptz AS parked
        FROM harness_shared.routines WHERE workspace_id = ${WS} ORDER BY id`;
    expect(rows.find((r) => r.id === 'rt-start-proof')?.parked).toBe(true);
    expect(rows.find((r) => r.id === 'rt-no-start-proof')?.parked).toBe(false);
    expect(result.loops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rt-no-start-proof', via: 'delivered-wake-no-loop-turn' }),
    ]));
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp', 'rt-no-start-proof', 'loop-delivered-wake-no-loop-turn', 'error',
    );
    expect(recordFire).not.toHaveBeenCalledWith(
      'papercusp', 'rt-start-proof', 'loop-delivered-wake-no-loop-turn', 'error',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loop 'rt-no-start-proof'"));
  });
});
