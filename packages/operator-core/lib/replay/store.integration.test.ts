/**
 * store.integration.test.ts — replay-run SQL over migration 247 (P-020 /
 * FB-06) against a real provisioned PG (provisionGymDatabase applies
 * 000-baseline + every pending migration, so harness_shared.replay_runs and
 * the governor's 244 tables exist). Round-trips the cell lifecycle, pins the
 * signal_origin CHECK (D-002 vocabulary stays closed), and proves the P-001
 * arming act end-to-end: unregistered ⇒ governor refuses; registerReplayLoop
 * with a budget ⇒ allows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { governorCheck } from '../learning-governor/store';
import { registerReplayLoop } from './governed';
import { PgReplayStore, listReplayRuns } from './store';
import { REPLAY_LOOP_ID, type ReplayCase, type ReplayVariant } from './types';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `replay_${randomBytes(5).toString('hex')}`;
const WS = 'ws-replay-test';

const variant: ReplayVariant = { variantId: 'candidate-1', label: 'pin mocks', policy: { systemOverlay: 'pin mocks' } };
const replayCase: ReplayCase = {
  kind: 'historical',
  caseId: 'case-1',
  transcript: { ref: 'logs/1777-worker.jsonl', turns: [] },
  turnIndex: 3,
};

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  // Best-effort: the reused test container is shared across vitest processes
  // on the dev box — a concurrent suite's teardown can stop it first (404).
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

describe('PgReplayStore — cell lifecycle', () => {
  it('startRun inserts a started row born origin=replay', async () => {
    const store = new PgReplayStore(sql, WS);
    await store.startRun({ runId: 'r1', batteryId: 'bat-1', variant, replayCase, repeat: 0 });
    const [row] = await listReplayRuns(sql, { workspaceId: WS, batteryId: 'bat-1' });
    expect(row).toMatchObject({
      runId: 'r1',
      batteryId: 'bat-1',
      variantId: 'candidate-1',
      caseRef: 'logs/1777-worker.jsonl',
      turnIndex: 3,
      status: 'started',
      signalOrigin: 'replay',
    });
  });

  it('finishRun + recordScore complete the cell (cost accumulates run+judge)', async () => {
    const store = new PgReplayStore(sql, WS);
    await store.finishRun('r1', { divergence: { divergence: { tokenJaccard: 0.4 }, replayed: true }, costUsd: 0.05, elapsedMs: 1200 });
    await store.recordScore('r1', {
      d1: 9,
      d2: 8,
      d3: 9,
      composite: 8.7,
      rationale: 'fixed root cause',
      rubricHash: 'abc123',
      costUsd: 0.01,
    });
    const [row] = await listReplayRuns(sql, { workspaceId: WS, batteryId: 'bat-1' });
    expect(row).toMatchObject({ status: 'scored', composite: 8.7, judgeRationale: 'fixed root cause', rubricHash: 'abc123' });
    expect(row.costUsd).toBeCloseTo(0.06, 10);
    expect((row.divergence as { replayed?: boolean }).replayed).toBe(true);
  });

  it('markFailed upserts a budget-refused cell that never started', async () => {
    const store = new PgReplayStore(sql, WS);
    await store.markFailed('r-refused', { status: 'errored', error: 'replay budget cap reached', elapsedMs: 0 });
    const rows = await listReplayRuns(sql, { workspaceId: WS });
    const refused = rows.find((r) => r.runId === 'r-refused');
    expect(refused).toMatchObject({ status: 'errored', error: 'replay budget cap reached', signalOrigin: 'replay' });
  });

  it('the signal_origin CHECK keeps the D-002 vocabulary closed', async () => {
    await expect(
      sql`
        INSERT INTO harness_shared.replay_runs (workspace_id, run_id, battery_id, variant_id, case_ref, signal_origin)
        VALUES (${WS}, 'r-bad', 'bat-x', 'v', 'ref', 'bogus')
      `,
    ).rejects.toThrow(/signal_origin/);
  });

  it('the status CHECK rejects unknown dispositions', async () => {
    await expect(
      sql`
        INSERT INTO harness_shared.replay_runs (workspace_id, run_id, battery_id, variant_id, case_ref, status)
        VALUES (${WS}, 'r-bad2', 'bat-x', 'v', 'ref', 'limbo')
      `,
    ).rejects.toThrow(/status/);
  });
});

describe('the P-001 arming act (governor end-to-end)', () => {
  it('unregistered ⇒ the governor refuses; registerReplayLoop with a budget ⇒ allows', async () => {
    const before = await governorCheck(sql, { workspaceId: WS, loopId: REPLAY_LOOP_ID });
    expect(before).toMatchObject({ allow: false, reason: 'unregistered' });

    // Registered but UNBUDGETED is still dark (D-004 null-budget refusal).
    await registerReplayLoop(sql, { workspaceId: WS, budgetUsd: null });
    const unbudgeted = await governorCheck(sql, { workspaceId: WS, loopId: REPLAY_LOOP_ID });
    expect(unbudgeted).toMatchObject({ allow: false, reason: 'unbudgeted' });

    // The arming act: an owner-set budget.
    await registerReplayLoop(sql, { workspaceId: WS, budgetUsd: 10 });
    const armed = await governorCheck(sql, { workspaceId: WS, loopId: REPLAY_LOOP_ID });
    expect(armed).toMatchObject({ allow: true });
    expect(armed.remainingUsd).toBe(10);
  });
});
