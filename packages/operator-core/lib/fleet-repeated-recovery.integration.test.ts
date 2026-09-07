/**
 * Real-Postgres coverage for the repeated-recovery classifier's dual-ledger
 * read. The unit suite pins the pure classifier; this file pins the production
 * interval query, including the intentionally split workspace scopes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { readFleetRepeatedRecoveryStates } from './fleet-repeated-recovery';

let fixture: BaselineCoordFixture;
let sql: postgres.Sql;
let partIndex = 0;

const WORKSPACE = 'p005-repeated-recovery-ws';
const OTHER_WORKSPACE = 'p005-repeated-recovery-other-ws';
const OWNER_PREFIX = 'su-p005-repeated-recovery-';
const OWNER_RECOVERY = `${OWNER_PREFIX}recovery`;
const OWNER_OTHER = `${OWNER_PREFIX}other-workspace`;
const OWNER_USEFUL = `${OWNER_PREFIX}useful`;
const OWNER_INCOMPLETE = `${OWNER_PREFIX}incomplete`;
const T0 = Date.parse('2026-09-07T12:00:00.000Z');

async function seedTool(input: {
  ownerId: string;
  toolName: string;
  atMs: number;
  activityWorkspace?: string;
  activity?: boolean;
  transcript?: boolean;
}): Promise<void> {
  if (input.activity !== false) {
    await sql`
      INSERT INTO harness_shared.agent_activity
        (workspace_id, owner_id, agent, session_id, harness_slug, kind,
         tool_name, phase, status, summary, created_at)
      VALUES (
        ${input.activityWorkspace ?? WORKSPACE}, ${input.ownerId}, 'codex',
        ${`session-${input.ownerId}`}, 'papercusp', 'tool', ${input.toolName},
        'post', 'ok', 'P-005 repeated-recovery real-PG fixture', ${new Date(input.atMs)}
      )`;
  }

  if (input.transcript !== false) {
    await sql`
      INSERT INTO harness_shared.session_turn_parts
        (workspace_id, source_kind, session_id, part_idx, ts, owner,
         speaker, part_kind, tool_name, text)
      VALUES (
        'default', 'codex', ${`session-${input.ownerId}`}, ${++partIndex},
        ${new Date(input.atMs)}, ${input.ownerId}, 'assistant', 'tool_use',
        ${input.toolName}, '{}'
      )`;
  }
}

async function seedBoundary(ownerId: string, atMs: number, activityWorkspace = WORKSPACE): Promise<void> {
  await seedTool({ ownerId, toolName: 'loop:checkpoint', atMs, activityWorkspace });
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id LIKE ${`${OWNER_PREFIX}%`}`;
  await sql`DELETE FROM harness_shared.session_turn_parts WHERE owner LIKE ${`${OWNER_PREFIX}%`}`;
}

beforeAll(async () => {
  fixture = await setupBaselineCoordFixture();
  sql = fixture.admin;
}, 180_000);

afterAll(async () => {
  await cleanup().catch(() => {});
  await fixture?.dispose();
}, 180_000);

beforeEach(async () => {
  partIndex = 0;
  await cleanup();
});

describe('readFleetRepeatedRecoveryStates against real Postgres', () => {
  it('builds checkpoint intervals across workspace + wildcard rows and excludes another workspace', async () => {
    await seedBoundary(OWNER_RECOVERY, T0, '*');
    await seedTool({ ownerId: OWNER_RECOVERY, toolName: 'coord:orient', atMs: T0 + 1_000 });
    await seedTool({ ownerId: OWNER_RECOVERY, toolName: 'work_items:get', atMs: T0 + 2_000 });
    await seedBoundary(OWNER_RECOVERY, T0 + 10_000);
    await seedTool({ ownerId: OWNER_RECOVERY, toolName: 'coord:orient', atMs: T0 + 11_000 });
    await seedTool({ ownerId: OWNER_RECOVERY, toolName: 'work_items:get', atMs: T0 + 12_000 });
    await seedBoundary(OWNER_RECOVERY, T0 + 20_000);

    await seedBoundary(OWNER_OTHER, T0, OTHER_WORKSPACE);
    await seedTool({
      ownerId: OWNER_OTHER,
      toolName: 'coord:orient',
      atMs: T0 + 1_000,
      activityWorkspace: OTHER_WORKSPACE,
    });
    await seedBoundary(OWNER_OTHER, T0 + 10_000, OTHER_WORKSPACE);
    await seedBoundary(OWNER_OTHER, T0 + 20_000, OTHER_WORKSPACE);

    const states = await readFleetRepeatedRecoveryStates(
      [{ ownerId: OWNER_RECOVERY }, { ownerId: OWNER_OTHER }],
      { sql, workspaceId: WORKSPACE, nowMs: T0 + 30_000, lookbackMs: 60_000 },
    );

    expect(states.get(OWNER_RECOVERY)).toMatchObject({
      status: 'measured',
      consecutiveRecoveryOnlyCycles: 2,
      observedCycles: 2,
    });
    expect(states.get(OWNER_OTHER)).toEqual({
      status: 'unknown',
      consecutiveRecoveryOnlyCycles: null,
      reason: 'insufficient-boundaries',
    });
  });

  it('treats useful native work in the newest checkpoint interval as a streak reset', async () => {
    await seedBoundary(OWNER_USEFUL, T0);
    await seedTool({ ownerId: OWNER_USEFUL, toolName: 'coord:orient', atMs: T0 + 1_000 });
    await seedBoundary(OWNER_USEFUL, T0 + 10_000);
    await seedTool({ ownerId: OWNER_USEFUL, toolName: 'Read', atMs: T0 + 11_000 });
    await seedBoundary(OWNER_USEFUL, T0 + 20_000);

    const states = await readFleetRepeatedRecoveryStates([{ ownerId: OWNER_USEFUL }], {
      sql,
      workspaceId: WORKSPACE,
      nowMs: T0 + 30_000,
      lookbackMs: 60_000,
    });

    expect(states.get(OWNER_USEFUL)).toMatchObject({
      status: 'measured',
      consecutiveRecoveryOnlyCycles: 0,
      observedCycles: 1,
    });
  });

  it('fails closed when agent_activity has a post call missing from session_turn_parts', async () => {
    await seedBoundary(OWNER_INCOMPLETE, T0);
    await seedTool({ ownerId: OWNER_INCOMPLETE, toolName: 'coord:orient', atMs: T0 + 1_000 });
    await seedBoundary(OWNER_INCOMPLETE, T0 + 10_000);
    await seedTool({ ownerId: OWNER_INCOMPLETE, toolName: 'coord:orient', atMs: T0 + 11_000 });
    await seedTool({
      ownerId: OWNER_INCOMPLETE,
      toolName: 'work_items:get',
      atMs: T0 + 12_000,
      transcript: false,
    });
    await seedBoundary(OWNER_INCOMPLETE, T0 + 20_000);

    const states = await readFleetRepeatedRecoveryStates([{ ownerId: OWNER_INCOMPLETE }], {
      sql,
      workspaceId: WORKSPACE,
      nowMs: T0 + 30_000,
      lookbackMs: 60_000,
    });

    expect(states.get(OWNER_INCOMPLETE)).toEqual({
      status: 'unknown',
      consecutiveRecoveryOnlyCycles: null,
      reason: 'incomplete-coverage',
    });
  });
});
