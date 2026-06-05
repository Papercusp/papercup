/**
 * backup-workflow.integration.test.ts — plan dbos-durable-flows-adoption P-011 /
 * P-009: the backup snapshot workflow's durable-result + exactly-once-per-
 * workflowID guarantees, proven against a REAL DBOS runtime (the property that
 * makes a snapshot crash-resumable can only be shown with a live DBOS instance).
 *
 * `startBackupSnapshotWorkflow` enqueues a workflow keyed by a per-request
 * `workflowID = backup-snapshot:<ws>:<reason>:<nonce>` and awaits its result. A
 * RE-invocation with the SAME workflowID returns the durable cached result
 * WITHOUT re-running the executor — DBOS's exactly-once-per-id property, which is
 * exactly what lets a resumed snapshot pick up where it left off. Distinct
 * nonces are independent runs (no dedup mutex — manual snapshots keep today's
 * "both run" behavior).
 *
 * Boots DBOS on a throwaway DB on the shared testcontainer (mirrors
 * provision-workflow.integration.test.ts) and injects a counting stub executor —
 * so the durable-result mechanics are proven WITHOUT spawning a kopia snapshot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import type { SnapshotResult, SnapshotTriggerReason } from '@papercusp/backup';

let DBOS: typeof DBOSType;
let startBackupSnapshotWorkflow: typeof import('./backup-workflow').startBackupSnapshotWorkflow;
let setBackupSnapshotExecutor: typeof import('./backup-workflow').setBackupSnapshotExecutor;
let startBackupPromoteWorkflow: typeof import('./backup-workflow').startBackupPromoteWorkflow;
let setPromoteExecutor: typeof import('./backup-workflow').setPromoteExecutor;
let adminUri: string;
let dbName: string;

// (workspace, reason) → number of times the (stub) executor actually ran.
const execCount: Record<string, number> = {};
const key = (ws: string, reason: string) => `${ws}:${reason}`;
const nonce = () => randomBytes(6).toString('hex');

const result = (kopiaSnapshotId: string): SnapshotResult => ({
  snapshotId: 1,
  kopiaSnapshotId,
  bytesAdded: 10,
  durationMs: 1,
});

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_${randomBytes(5).toString('hex')}`;
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

  const wf = await import('./backup-workflow');
  startBackupSnapshotWorkflow = wf.startBackupSnapshotWorkflow;
  setBackupSnapshotExecutor = wf.setBackupSnapshotExecutor;
  startBackupPromoteWorkflow = wf.startBackupPromoteWorkflow;
  setPromoteExecutor = wf.setPromoteExecutor;
  // Stub executor: count the run, hold briefly, then succeed. No kopia, no PG.
  setBackupSnapshotExecutor(
    async (ws: string, reason: SnapshotTriggerReason): Promise<SnapshotResult> => {
      execCount[key(ws, String(reason))] = (execCount[key(ws, String(reason))] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, 50));
      return result(`kopia-${ws}-${String(reason)}`);
    },
  );

  await DBOS.launch();
}, 90_000);

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

beforeEach(() => {
  for (const k of Object.keys(execCount)) delete execCount[k];
});

describe('DBOS backup snapshot workflow — durable result (P-011)', () => {
  it('awaits the durable result on the happy path (tool keeps its sync contract)', async () => {
    const r = await startBackupSnapshotWorkflow({ workspaceId: 'ws-1', reason: 'manual' }, nonce());
    expect(r.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(execCount[key('ws-1', 'manual')]).toBe(1);
  }, 30_000);

  it('re-invoking the SAME workflowID returns the cached result WITHOUT re-running (exactly-once)', async () => {
    const input = { workspaceId: 'ws-1', reason: 'manual' as const };
    const n = nonce();
    const r1 = await startBackupSnapshotWorkflow(input, n);
    const r2 = await startBackupSnapshotWorkflow(input, n); // same workflowID
    expect(r1).toEqual(r2);
    // The decisive assertion: the executor ran exactly once — the second call
    // replayed the durable result, exactly the crash-resume property.
    expect(execCount[key('ws-1', 'manual')]).toBe(1);
  }, 30_000);

  it('distinct nonces are independent runs (no dedup mutex — both run)', async () => {
    const input = { workspaceId: 'ws-1', reason: 'manual' as const };
    const [a, b] = await Promise.all([
      startBackupSnapshotWorkflow(input, nonce()),
      startBackupSnapshotWorkflow(input, nonce()),
    ]);
    expect(a.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(b.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(execCount[key('ws-1', 'manual')]).toBe(2);
  }, 30_000);
});

describe('DBOS backup destructive trio — durable result (P-012)', () => {
  it('promote: durable result + exactly-once per workflowID (the crash-resume property)', async () => {
    let runs = 0;
    // Stub the destructive op so the DBOS mechanics are proven without real FS
    // renames; opId is threaded from the nonce (deterministic broken-dir name).
    setPromoteExecutor(async (i) => {
      runs++;
      return { broken: `/.broken-${i.opId}-live`, live: i.liveTarget ?? '/live' };
    });
    const n = nonce();
    const input = { workspaceId: 'ws-1', restoredPath: '/.restored/s1/live', liveTarget: '/live' };
    const r1 = await startBackupPromoteWorkflow(input, n);
    const r2 = await startBackupPromoteWorkflow(input, n); // same workflowID
    expect(r1).toEqual(r2);
    // The destructive op ran exactly once; the re-invocation replayed the
    // durable result — exactly what makes a half-done promote safe to resume.
    expect(runs).toBe(1);
    expect(r1.broken).toBe(`/.broken-${n}-live`);
    setPromoteExecutor(null);
  }, 30_000);
});
