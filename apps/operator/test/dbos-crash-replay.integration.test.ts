/**
 * dbos-crash-replay.integration.test.ts — plan harness-test-coverage-for-launch
 * P-007: crash-mid-pipeline replay safety, proven against a REAL DBOS runtime.
 *
 * The durable pipeline runs each agent turn as a checkpointed DBOS step
 * (`decide-<turn>` / `invoke-<role>-<turn>`), and passes each role a DETERMINISTIC
 * idempotency key `slug:feature:role:t<turn>` (orchestrator-workflow.ts `key()`).
 * The safety property: when a step fails part-way through a pipeline ("a crash
 * between durable steps"), DBOS retries the FAILED step and the already-completed
 * roles are NOT re-invoked — their checkpoints stand, and the same idempotency key
 * is reused, never producing a second execution of a finished role.
 *
 * This drives a real two-turn pipeline (director → worker → DONE) and forces the
 * SECOND director decide to throw once. The decide step is `retriesAllowed`, so
 * DBOS retries it; we assert the turn-0 worker was invoked exactly once across the
 * failure+retry, and that the keys are deterministic per (role, turn).
 *
 * First-DBOS-in-test pattern (see orchestrator-dedup.integration.test.ts): a
 * throwaway database, a counting fake runner, DBOS torn down in afterAll. The
 * integration config runs files in separate processes, isolating the singleton.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';

let DBOS: typeof DBOSType;
let startFeaturePipeline: typeof import('@papercusp/operator-core/lib/dbos/orchestrator-workflow').startFeaturePipeline;
let adminUri: string;
let dbName: string;

/** Every role invocation: the role + the idempotency key it was handed. */
const calls: Array<{ role: string; key: string }> = [];
/** director decide attempts so far (1=turn0, 2=turn1-attempt1, 3=turn1-attempt2…). */
let directorAttempts = 0;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_replay_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: u.toString(),
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  const wf = await import('@papercusp/operator-core/lib/dbos/orchestrator-workflow');
  startFeaturePipeline = wf.startFeaturePipeline;

  // Fake runner: director drives turn0→NEXT_WORKER, turn1→DONE, but THROWS once
  // on the first turn-1 decide (the simulated mid-pipeline crash). Each call
  // records the idempotency key it was handed (arg index 3).
  wf.setPipelineInvokeRunner(async (_slug, role, feature, idempotencyKey) => {
    calls.push({ role, key: idempotencyKey });
    if (role === 'director') {
      directorAttempts += 1;
      if (directorAttempts === 1) return { output: `NEXT_WORKER ${feature}`, exitCode: 0 };
      if (directorAttempts === 2) throw new Error('SIMULATED CRASH between durable steps');
      return { output: 'DONE', exitCode: 0 };
    }
    return { output: `ran ${role}`, exitCode: 0 };
  });

  await DBOS.launch();
}, 120_000);

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
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

describe('DBOS pipeline crash-mid-replay safety (P-007)', () => {
  it('a failed decide step retries WITHOUT re-invoking the completed worker; keys are deterministic', async () => {
    // DBOS logs the (intentional) step failure + retry at warn/error level; the
    // suite's fail-on-console would otherwise fail the test on that expected
    // noise. Swallow it for the duration; the assertions still validate behavior.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const id = await startFeaturePipeline({ harnessSlug: 'sheets', featureId: 'F-CRASH', epoch: 0, workspaceId: 'ws-1' });

      // The decide step is retriesAllowed (5s interval) → completion includes one retry.
      const result = await DBOS.getResult<string>(id, 45);
      expect(result).toBe('pipeline-complete (last=DONE)');

      const workerCalls = calls.filter((c) => c.role === 'worker');
      const directorCalls = calls.filter((c) => c.role === 'director');

      // The decisive invariant: the worker (a COMPLETED durable step) ran exactly
      // once — the turn-1 decide failure + retry did NOT replay it.
      expect(workerCalls).toHaveLength(1);
      expect(workerCalls[0].key).toBe('sheets:F-CRASH:worker:t0');

      // The director decide fired 3× total: turn0 (NEXT_WORKER), turn1 attempt-1
      // (threw), turn1 attempt-2 (DONE).
      expect(directorCalls).toHaveLength(3);

      // Idempotency keys are deterministic per (role, turn): turn0 decide, turn0
      // worker, and BOTH turn1 decide attempts share the SAME turn-1 key (so a
      // re-attempt reuses the key rather than minting a new execution).
      expect(directorCalls.map((c) => c.key)).toEqual([
        'sheets:F-CRASH:director:t0',
        'sheets:F-CRASH:director:t1',
        'sheets:F-CRASH:director:t1',
      ]);

      // Across all roles, the distinct idempotency keys are exactly one per
      // (role, turn) — no key collision, no missing key.
      expect([...new Set(calls.map((c) => c.key))].sort()).toEqual([
        'sheets:F-CRASH:director:t0',
        'sheets:F-CRASH:director:t1',
        'sheets:F-CRASH:worker:t0',
      ]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 90_000);
});
