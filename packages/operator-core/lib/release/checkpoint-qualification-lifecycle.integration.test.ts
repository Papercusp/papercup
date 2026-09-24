/** Real Postgres regression for the shared qualification/repair row. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: db.sql }) }));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(async (tx) => run(tx as Sql)),
}));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  checkpointPidIdentity,
  classifyScheduledQualificationJoin,
  probeRunnerLiveness,
  readStoredQualification,
  recordStoredQualificationRunnerProgress,
  recordStoredQualificationScheduledFire,
  recordStoredQualificationVerdict,
  reserveStoredQualificationRunner,
  settleQualificationTransaction,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
} from './frozen-candidate-repair-queue';
import { fireAwaitsForKey, registerAwait } from '../events/await/store';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-checkpoint-lifecycle', installSlug: 'papercusp' };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
});

async function seed(metadata: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-checkpoint-lifecycle', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

async function metadata(): Promise<Record<string, unknown>> {
  const rows = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  return rows[0]!.metadata;
}

describe('checkpoint qualification lifecycle (real row lock and JSONB)', () => {
  it('joins one physical runner, separates clocks, and refuses stale terminal identity', async () => {
    await seed();
    const begun = await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 1_000,
    });
    expect(begun.status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 2_000)).status).toBe('updated');
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', leaseDurationMs: 1_000_000,
      started: false, nowMs: 2_100,
    })).status).toBe('updated');
    const pidIdentity = checkpointPidIdentity(process.pid)!;
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: process.pid, pidIdentity, leaseDurationMs: 1_000_000, started: true, nowMs: 2_200,
    })).status).toBe('updated');
    expect((await recordStoredQualificationRunnerProgress(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pidIdentity, phase: 'suite', nowMs: 3_000,
    })).status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 4_000)).status).toBe('updated');
    const running = await readStoredQualification(target);
    expect(running.status).toBe('present');
    if (running.status !== 'present') return;
    expect(running.transaction).toMatchObject({
      runId: 'run-1', lastScheduledAtMs: 4_000, lastStartedAtMs: 2_200,
      lastProgressAtMs: 3_000, currentPhysicalRunner: { phase: 'suite', pidIdentity },
    });
    expect(classifyScheduledQualificationJoin(running.transaction,
      probeRunnerLiveness(running.transaction.currentPhysicalRunner))).toBe('join');

    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_000,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_100,
    })).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'advanced', green: true, nowMs: 5_200,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_200,
    })).status).toBe('terminal');
    const terminal = await readStoredQualification(target);
    expect(terminal).toMatchObject({ status: 'present', transaction: {
      phase: 'terminal', lastScheduledAtMs: 4_000, lastProgressAtMs: 3_000,
      lastTerminalVerdictAtMs: 5_100, outcome: { kind: 'red' },
    } });
  });

  it('commits predecessor reconciliation and successor qualification in the same row update', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await seed({ qualificationTransaction: terminal, repair_queue: admitted });
    const next = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(next).toMatchObject({ status: 'updated', repairQueueReconciliation: { status: 'preserved' } });
    const stored = await metadata();
    expect(stored.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2', candidate: 'repair-1' });
    expect(stored.repair_queue).toMatchObject({
      candidate: 'candidate-1', repairHead: 'repair-1', qualificationAttemptId: 'attempt-2',
    });
  });

  it('preserves an unknown live PID even after lease expiry, then reclaims only a proved changed identity', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    await seed({ qualificationTransaction: {
      ...ready, phase: 'running', currentPhysicalRunner: {
        id: 'old-runner', candidate: 'candidate-1', reservedAtMs: 100,
        leaseExpiresAtMs: 200, evidenceRefs: [], pid: process.pid, pidIdentity: null,
      },
    } });
    const replacement = { attemptId: 'attempt-1', runnerId: 'new-runner', leaseDurationMs: 1_000, nowMs: 1_000 };
    expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('conflict');
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{qualificationTransaction,currentPhysicalRunner,pidIdentity}',
                                  '"old-boot:1"'::jsonb, true)
       WHERE workspace_id = ${target.workspaceId}`;
    const reclaimed = await reserveStoredQualificationRunner(target, replacement);
    expect(reclaimed).toMatchObject({ status: 'updated', transaction: {
      currentPhysicalRunner: { id: 'new-runner' },
      consumedPhysicalRuns: [{ id: 'old-runner', outcome: {
        kind: 'pre-suite-no-verdict', reason: 'runner-vanished',
      } }],
    } });
  });

  it('leaves a foreign repair queue and predecessor qualification byte-identical on conflict', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const foreign = createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'foreign-attempt', base: null, nowMs: 150,
    });
    await seed({ qualificationTransaction: terminal, repair_queue: foreign });
    const before = await metadata();
    const result = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(result.status).toBe('conflict');
    expect(await metadata()).toEqual(before);
  });

  it('fires only the exact candidate await once on the durable event store', async () => {
    const key = 'green-checkpoint:red:papercusp-lifecycle-test';
    const a = await registerAwait({
      subscriberId: 'su-candidate-a', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-a' } },
    });
    const b = await registerAwait({
      subscriberId: 'su-candidate-b', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-b' } },
    });
    const first = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } });
    expect(first.map((row) => row.id)).toEqual([a.id]);
    expect(await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } })).toEqual([]);
    const second = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-b123', runId: 'run-b' } });
    expect(second.map((row) => row.id)).toEqual([b.id]);
  });
});
