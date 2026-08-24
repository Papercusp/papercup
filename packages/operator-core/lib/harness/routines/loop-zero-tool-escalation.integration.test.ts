/**
 * Real-Postgres guard for WI-41228's routine-metadata streak. The unit seam proves the state
 * machine; this file proves the actual JSONB UPDATE/RETURNING statement, metadata merge, and
 * same-fire idempotency against the migrated routines table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { recordZeroToolFireObservation } from './loop-zero-tool-escalation';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-zero-tool-escalation';
const ROUTINE_ID = 'rt-zero-tool-escalation';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
       workspace_id, reschedule_interval_sec, target_owner_id, next_fire_at, active, metadata)
    VALUES (
      ${ROUTINE_ID}, 'papercusp', 'loop-su-zero-tool', 'cron', '{}'::jsonb, 'loop', '{}'::jsonb,
      ${WS}, 60, 'su-zero-tool', 'infinity'::timestamptz, TRUE, '{"keep":"me"}'::jsonb
    )
  `;
});

describe('recordZeroToolFireObservation — real routines metadata', () => {
  it('counts each fire once, resets on productive work, and reaches the bounded threshold', async () => {
    const first = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-1',
      toolCalls: 0,
      threshold: 3,
    });
    const duplicate = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-1',
      toolCalls: 0,
      threshold: 3,
    });
    const second = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-2',
      toolCalls: 0,
      threshold: 3,
    });
    const productive = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-3',
      toolCalls: 2,
      threshold: 3,
    });

    expect(first).toMatchObject({ counted: true, streak: 1, atThreshold: false });
    expect(duplicate).toMatchObject({ counted: false, streak: 1, atThreshold: false });
    expect(second).toMatchObject({ counted: true, streak: 2, atThreshold: false });
    expect(productive).toMatchObject({ counted: true, streak: 0, toolCalls: 2, atThreshold: false });

    await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-4',
      toolCalls: 0,
      threshold: 3,
    });
    await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-5',
      toolCalls: 0,
      threshold: 3,
    });
    const threshold = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-6',
      toolCalls: 0,
      threshold: 3,
    });
    expect(threshold).toMatchObject({ counted: true, streak: 3, atThreshold: true });

    const [row] = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM harness_shared.routines WHERE id = ${ROUTINE_ID}
    `;
    expect(row.metadata.keep).toBe('me');
    expect(row.metadata.loop_zero_tool_streak).toBe(3);
    expect(row.metadata.loop_zero_tool_last_fire_token).toBe('fire-6');
    expect(row.metadata.loop_zero_tool_threshold).toBe(3);
    expect(row.metadata.loop_zero_tool_last_counted_at).toBeTruthy();
  });

  it('does not mutate or resurrect an inactive routine', async () => {
    await sql`UPDATE harness_shared.routines SET active = FALSE WHERE id = ${ROUTINE_ID}`;
    const result = await recordZeroToolFireObservation(sql, {
      routineId: ROUTINE_ID,
      fireToken: 'fire-after-pause',
      toolCalls: 0,
      threshold: 3,
    });
    expect(result).toBeNull();
  });
});
