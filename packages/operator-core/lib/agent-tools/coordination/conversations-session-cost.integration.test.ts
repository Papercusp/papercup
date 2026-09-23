import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { runWithWorkspace } from '../../workspace-als';

const orgDb = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: orgDb.sql }) as never,
}));

import { getConsultStates } from './conversations';

const WS = 'consult-cost-ws';
let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('consult-session-cost');
  sql = db.sql;
  orgDb.sql = sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`CREATE TABLE harness_shared.consult_state (
    workspace_id text NOT NULL,
    conversation_id text NOT NULL,
    state text NOT NULL,
    latency_contract text,
    responder_id text,
    expires_at timestamptz,
    closed_at timestamptz,
    wakes_used integer,
    routing jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, conversation_id)
  )`);
  await sql.unsafe(`CREATE TABLE harness_shared.adv_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    coord_owner_id text NOT NULL,
    session_id text NOT NULL,
    started_at timestamptz NOT NULL
  )`);
  await sql.unsafe(`CREATE TABLE harness_shared.agent_usage_samples (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    session_id text NOT NULL,
    ts bigint NOT NULL,
    cost_usd numeric,
    cost_source text
  )`);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.consult_state,
                    harness_shared.adv_sessions,
                    harness_shared.agent_usage_samples RESTART IDENTITY`;
});

describe('getConsultStates session cost projection (P-007)', () => {
  it('correlates post-consult native-session samples and keeps priced, estimated, unpriced, and pending distinct', async () => {
    const createdAt = '2026-09-23T08:00:00.000Z';
    const startedAt = '2026-09-23T08:01:00.000Z';
    const startedMs = Date.parse(startedAt);
    for (const [conversationId, answerOwnerId] of [['consult-measured', 'answer-measured'], ['consult-pending', 'answer-pending']]) {
      await sql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, state, latency_contract, responder_id,
           expires_at, closed_at, wakes_used, routing, created_at)
        VALUES (${WS}, ${conversationId}, 'closed_answered', 'proceed', 'expert',
                ${startedAt}::timestamptz, ${startedAt}::timestamptz, 1,
                ${sql.json({ selection: { selected: [{ ownerId: 'expert', answeringOwnerId: answerOwnerId }] } } as never)},
                ${createdAt}::timestamptz)
      `;
      await sql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, started_at)
        VALUES (${WS}, ${answerOwnerId}, ${`native-${answerOwnerId}`}, ${startedAt}::timestamptz)
      `;
    }

    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, session_id, ts, cost_usd, cost_source)
      VALUES
        (${WS}, 'native-answer-measured', ${startedMs - 1}, 9.99, 'provider'),
        (${WS}, 'native-answer-measured', ${startedMs + 1}, 0.01, 'provider'),
        (${WS}, 'native-answer-measured', ${startedMs + 2}, 0.02, 'estimated'),
        (${WS}, 'native-answer-measured', ${startedMs + 3}, NULL, 'provider'),
        (${WS}, 'unrelated-session', ${startedMs + 4}, 5.00, 'provider')
    `;

    const states = await runWithWorkspace(WS, () => getConsultStates(['consult-measured', 'consult-pending']));
    expect(states.get('consult-measured')?.session_cost).toEqual({
      status: 'partial',
      usd: 0.03,
      sample_count: 3,
      priced_sample_count: 1,
      estimated_sample_count: 1,
      unpriced_sample_count: 1,
    });
    expect(states.get('consult-pending')?.session_cost).toEqual({
      status: 'pending',
      usd: null,
      sample_count: 0,
      priced_sample_count: 0,
      estimated_sample_count: 0,
      unpriced_sample_count: 0,
    });
  });
});
