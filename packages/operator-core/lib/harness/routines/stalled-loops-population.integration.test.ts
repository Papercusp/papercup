/**
 * P-007 / WI-41230 — the workspace population census against a real migrated Postgres.
 *
 * The unit tests pin the alarm policy. This test pins the load-bearing SQL population and the
 * shared behavior predicate: active loop owners only, `infinity` as the parked sentinel, recent
 * agent-authored calls as activity, and carry-note bookkeeping / automatic calls excluded.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/stalled-loops-population.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { readLoopPopulationSnapshot } from './stalled-loops-guard';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop-population';
const OTHER_WS = 'ws-loop-population-other';
const HARNESS = 'papercusp';
const OWNER_PREFIX = 'su-loop-pop-';
const ROUTINE_PREFIX = 'rt_ws_loop_pop_';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.tool_invocations
             WHERE coord_owner_id LIKE ${OWNER_PREFIX + '%'}`;
  await sql`DELETE FROM harness_shared.routines WHERE id LIKE ${ROUTINE_PREFIX + '%'}`;
});

async function seedRoutine(input: {
  suffix: string;
  ownerId: string | null;
  workspaceId?: string;
  name?: string;
  active?: boolean;
  parked?: boolean;
}): Promise<void> {
  const id = `${ROUTINE_PREFIX}${input.suffix}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       target_owner_id, concurrency, catchup, active, next_fire_at, reschedule_interval_sec)
    VALUES
      (${id}, ${HARNESS}, ${input.workspaceId ?? WS},
       ${input.name ?? `loop-${input.ownerId ?? input.suffix}`}, 'cron', '{}'::jsonb,
       'system:loop-wake', ${input.ownerId}, 'skip', 'skip-old', ${input.active ?? true},
       ${input.parked === false ? new Date(Date.now() + 60_000) : 'infinity'}::timestamptz, 60)
  `;
}

async function seedCall(input: {
  ownerId: string;
  toolName: string;
  invokedAt: Date;
  callOrigin: string | null;
  workspaceId?: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
       status, coord_owner_id, invoked_at, call_origin)
    VALUES
      (${input.workspaceId ?? WS}, ${HARNESS}, 'papercusp-su', ${input.toolName}, 'su',
       ${`spawn-${input.ownerId}`}, 'window-pop', 'ok', ${input.ownerId}, ${input.invokedAt},
       ${input.callOrigin})
  `;
}

describe('readLoopPopulationSnapshot (P-007, real PG)', () => {
  it('measures unique active owners and excludes automatic, bookkeeping, stale and out-of-scope evidence', async () => {
    const noCall = `${OWNER_PREFIX}no-call`;
    const realCall = `${OWNER_PREFIX}real-call`;
    const bookkeepingOnly = `${OWNER_PREFIX}bookkeeping-only`;
    const staleCall = `${OWNER_PREFIX}stale-call`;
    const scheduled = `${OWNER_PREFIX}scheduled`;

    await seedRoutine({ suffix: 'no_call', ownerId: noCall });
    await seedRoutine({ suffix: 'real_call', ownerId: realCall });
    await seedRoutine({ suffix: 'bookkeeping', ownerId: bookkeepingOnly });
    await seedRoutine({ suffix: 'stale', ownerId: staleCall });
    await seedRoutine({ suffix: 'scheduled', ownerId: scheduled, parked: false });

    // Controls that must never enter the active loop population.
    await seedRoutine({ suffix: 'inactive', ownerId: `${OWNER_PREFIX}inactive`, active: false });
    await seedRoutine({
      suffix: 'other_ws',
      ownerId: `${OWNER_PREFIX}other-workspace`,
      workspaceId: OTHER_WS,
    });
    await seedRoutine({
      suffix: 'not_loop',
      ownerId: `${OWNER_PREFIX}not-loop`,
      name: 'green-checkpoint',
    });
    await seedRoutine({ suffix: 'no_owner', ownerId: null, name: 'loop-no-owner' });

    const now = Date.now();
    // Owner identity is global: real work under another workspace still proves this owner is live.
    await seedCall({
      ownerId: realCall,
      toolName: 'work_items:get',
      invokedAt: new Date(now - 30 * 60_000),
      callOrigin: 'agent',
      workspaceId: OTHER_WS,
    });
    // Both are intentionally excluded by the canonical shared behavior contract.
    await seedCall({
      ownerId: bookkeepingOnly,
      toolName: 'loop:checkpoint',
      invokedAt: new Date(now - 20 * 60_000),
      callOrigin: 'agent',
    });
    await seedCall({
      ownerId: bookkeepingOnly,
      toolName: 'coord:glance',
      invokedAt: new Date(now - 10 * 60_000),
      callOrigin: null,
    });
    await seedCall({
      ownerId: staleCall,
      toolName: 'work_items:get',
      invokedAt: new Date(now - 4 * 60 * 60_000),
      callOrigin: 'agent',
    });

    const snapshot = await readLoopPopulationSnapshot({
      sql,
      workspaceId: WS,
      sinceMs: now - 3 * 60 * 60_000,
    });

    expect(snapshot).toEqual({
      status: 'measured',
      active: 5,
      parked: 4,
      parkedRatio: 4 / 5,
      parkedZeroTool3h: 3,
      parkedZeroToolRatio: 3 / 4,
      ownerSample: [bookkeepingOnly, noCall, staleCall].sort(),
    });
  });
});
