import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { buildConnectionOptions } from '@papercusp/db-org';
import { createFreshTestDb } from '@papercusp/test-config/pg';
import { createOrgTestDb } from '../../test/_org-test-db';
import { managedSpawn, markManagedSpawnTeardown } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { userManagerBusReachable } from '../systemd-scope';
import { runQualificationCommand, type QualificationCommandOptions } from './checkpoint-qualification-command';
import { beginQualificationTransaction, checkpointPidIdentity, observeQualificationProgress,
  probeRunnerLiveness, qualificationProgressFence, reserveQualificationRunner,
  parseCheckpointQualificationTransaction, QUALIFICATION_PROGRESS_STALE_MS, type CheckpointQualificationTransaction,
  readStoredQualification, recordStoredQualificationWorkProgress, recordStoredQualificationProgressObservation,
  type QualificationWorkProgressInput,
  type recordStoredQualificationChildScope } from './checkpoint-qualification-transaction';
import { sweepLostGateRuns } from './lost-gate-run-alarm';

const durable = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: durable.sql }),
}));
// The combined observer witness uses the migrated private row. The other cases
// retain their focused persistence fixtures and real process/cleanup paths.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({ registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})), closeTask: vi.fn(async () => true) }));

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch { return false; }
}

describe.runIf(process.platform === 'linux' && userManagerBusReachable())('qualification independent stalled-process bounds', () => {
  it('blocked-controller: external sweep observes durable declared progress and rejects repeated and stale renewal', async () => {
    const org = await createOrgTestDb();
    const sql = org.adminSql;
    durable.sql = sql;
    const dir = mkdtempSync(join(tmpdir(), 'qualification-blocked-progress-'));
    const ready = join(dir, 'ready.json'), trigger = join(dir, 'complete'), receipt = join(dir, 'receipt.json');
    const resumed = join(dir, 'controller-resumed');
    const target = { workspaceId: 'blocked-durable-workspace', installSlug: 'blocked-durable-install' };
    const id = newTaskId(), unit = scopeUnitForTask(id);
    const producer = `const fs = require('node:fs');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(trigger)})) return;
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ producerPid: process.pid,
          controllerPid: process.ppid, unitId: 'selected', completionId: 'blocked-durable-result',
          state: 'pass', observedAtMs: Date.now() }), { flush: true });
        clearInterval(timer);
      }, 10);`;
    const script = `const fs = require('node:fs');
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(producer)}], { stdio: 'ignore' });
      setImmediate(() => fs.writeFileSync(${JSON.stringify(resumed)}, 'event loop resumed'));
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }), { flush: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`;
    let worker: Awaited<ReturnType<typeof managedSpawn>> | undefined;
    try {
      worker = await managedSpawn(process.execPath, ['-e', script], {
        class: 'test-run', title: 'Blocked qualification with independent durable completion',
        argv: [process.execPath, '-e', script], cwd: process.cwd(),
        launchedBy: 'test:qualification-blocked-durable', runtimeMaxSec: 20,
      }, { taskId: id, workspaceId: target.workspaceId, requireConfinement: true, requireRegistration: true,
        scopeAvailable: true, spawnOptions: { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' } });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3000 });
      const { pid } = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number };
      const pidIdentity = checkpointPidIdentity(pid);
      if (!pidIdentity) throw new Error('blocked controller process identity unavailable');
      const nowMs = Date.now(), startedAtMs = nowMs - QUALIFICATION_PROGRESS_STALE_MS - 1000;
      const owner = { attemptId: 'blocked-durable-attempt', candidate: 'blocked-durable-candidate',
        runnerId: 'blocked-durable-runner', runId: 'blocked-durable-run', pid, pidIdentity,
        unit, nowMs: startedAtMs, leaseDurationMs: 1000, started: true };
      const tx = reserveQualificationRunner(beginQualificationTransaction(null, owner).transaction, owner).transaction;
      tx.currentPhysicalRunner = { ...tx.currentPhysicalRunner!, phase: 'suite', phaseEnteredAtMs: startedAtMs,
        heartbeatAtMs: startedAtMs, childScopeUnits: [unit], childScopeReservedAtMs: startedAtMs };
      expect(parseCheckpointQualificationTransaction(tx)).not.toBeNull();
      await sql`INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
        VALUES ('rt-blocked-durable', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
          'system:green-checkpoint', TRUE, ${target.workspaceId},
          ${JSON.stringify({ qualificationTransaction: tx })}::text::jsonb)`;
      const work: QualificationWorkProgressInput = { ...owner, nowMs, repairHead: null, root: process.cwd(),
        taskKey: 'blocked-durable-work', runContext: 'ci', runnerIdentity: 'proof-v3 blocked-durable', retryStates: [],
        manifest: { schemaVersion: 1, units: [
          { id: 'selected', kind: 'test', path: 'selected.test.ts' },
          { id: 'pending', kind: 'test', path: 'pending.test.ts' },
        ] }, updates: [] };
      expect(await recordStoredQualificationWorkProgress(target, work)).toMatchObject({ status: 'updated' });
      const read = async () => {
        const stored = await readStoredQualification(target);
        if (stored.status !== 'present') throw new Error(`qualification row: ${stored.status}`);
        return stored.transaction;
      };
      const held = structuredClone((await read()).currentPhysicalRunner);
      const fence = qualificationProgressFence(tx, target);
      const observations: Awaited<ReturnType<typeof recordStoredQualificationProgressObservation>>[] = [];
      let sampledAtMs = 0, monotonicAtMs = 0;
      const sweep = async (sequence: number, replay = false) => {
        if (!replay) { sampledAtMs = Date.now(); monotonicAtMs = performance.now(); }
        const result = await sweepLostGateRuns(sql, { nowMs: sampledAtMs, monotonicAtMs,
          observerGeneration: 'blocked-durable-external', observerSequence: sequence,
          probeQualificationRunner: runner => probeRunnerLiveness(runner),
          recordProgressObservation: async (target, sample) => {
            const result = await recordStoredQualificationProgressObservation(target, sample);
            observations.push(result);
            return result;
          }, claim: async () => true, readHolder: async () => null, hostFleetSlug: null,
          broadcast: async () => true, notifyOwner: async () => {}, attention: { resolve: async () => true } });
        expect(result.failed).toEqual([]);
        const stored = await read();
        expect(stored.currentPhysicalRunner).toEqual(held);
        expect(qualificationProgressFence(stored, target)).toBe(fence);
        expect(stored.outcome).toEqual({ kind: 'pending' });
        expect(await probeRunnerLiveness(stored.currentPhysicalRunner!)).toBe('live');
        expect(running(pid)).toBe(true);
        expect(existsSync(resumed)).toBe(false);
        return stored;
      };
      expect((await sweep(1)).progressObservation).toMatchObject({
        health: 'baseline', controller: 'silent', semantic: 'unknown', completedUnits: [] });
      expect((await sweep(2)).progressObservation).toMatchObject({
        health: 'healthy', controller: 'silent', semantic: 'unknown', completedUnits: [],
        lastUsefulProgressMonotonicMs: null });
      expect(existsSync(receipt)).toBe(false); // the manifest and baseline precede completion
      writeFileSync(trigger, 'complete selected work');
      await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 3000 });
      const { producerPid, controllerPid, ...completion } = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(controllerPid).toBe(pid);
      expect(producerPid).not.toBe(pid);
      const completed = { ...completion, firstAttemptVerdict: 'pass' as const, observedCount: 1, worktreeDirty: false,
        proof: { recordedSha: owner.candidate, runContext: work.runContext, runnerIdentity: work.runnerIdentity,
          executedModules: ['selected.test.ts'], readPaths: [], inputsCaptured: true, opaqueReasons: [] } };
      const update = { ...work, nowMs: Date.now(), updates: [{ receipt: completed }] };
      expect(await recordStoredQualificationWorkProgress(target, update)).toMatchObject({ status: 'updated' });
      // A separate committed read proves the completion is durable before the external sample.
      expect((await read()).continuation?.receipts).toEqual([completed]);
      const advanced = await sweep(3);
      expect(advanced.progressObservation).toMatchObject({ health: 'healthy', controller: 'silent', semantic: 'advancing',
        completedUnits: ['selected'], lastUsefulProgressMonotonicMs: monotonicAtMs });
      expect(await recordStoredQualificationWorkProgress(target, update)).toMatchObject({ status: 'idempotent' });
      const repeated = await sweep(4);
      expect(repeated.progressObservation).toMatchObject({ semantic: 'unchanged',
        lastUsefulProgressMonotonicMs: advanced.progressObservation!.lastUsefulProgressMonotonicMs });
      expect(await sweep(4, true)).toEqual(repeated);
      expect(observations.at(-1)).toMatchObject({ status: 'conflict', refusalReason: 'observer-sample-replay' });
      expect(await sweep(5, true)).toEqual(repeated);
      expect(observations.at(-1)).toMatchObject({ status: 'conflict', refusalReason: 'observer-sample-order' });
    } finally {
      if (worker) {
        markManagedSpawnTeardown(worker.child);
        await killScopeUnit(unit, { signal: 'SIGKILL' });
        await worker.waitForCompletion();
      }
      durable.sql = null;
      await org.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('quiet live work retains unknown custody across the stall horizon and records only declared semantic completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qualification-quiet-'));
    const ready = join(dir, 'ready.json'), trigger = join(dir, 'finish-subtask'), receipt = join(dir, 'receipt.json');
    const target = { workspaceId: 'quiet-workspace', installSlug: 'quiet-install' };
    const id = newTaskId(), unit = scopeUnitForTask(id);
    const script = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid}));
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(trigger)}) && !fs.existsSync(${JSON.stringify(receipt)}))
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,
            unitId:'test:declared-subtask',completionId:'quiet-result',state:'pass',observedAtMs:Date.now()}));
      }, 20);`;
    let output = '';
    const worker = await managedSpawn(process.execPath, ['-e', script], {
      class: 'test-run', title: 'Quiet qualification subtask', argv: [process.execPath, '-e', script],
      cwd: process.cwd(), launchedBy: 'test:qualification-quiet', runtimeMaxSec: 20,
    }, { taskId: id, workspaceId: target.workspaceId, requireConfinement: true, requireRegistration: true,
      scopeAvailable: true, spawnOptions: { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
      onSpawn(child) { child.stdout!.on('data', bytes => { output += bytes.toString(); }); } });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3000 });
      const { pid } = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number };
      const start = Date.now();
      let tx = reserveQualificationRunner(beginQualificationTransaction(null, {
        attemptId: 'quiet-attempt', candidate: 'quiet-candidate', nowMs: start,
      }).transaction, { attemptId: 'quiet-attempt', runnerId: 'quiet-runner', runId: 'quiet-run',
        unit, pid, pidIdentity: checkpointPidIdentity(pid), leaseDurationMs: 1000, nowMs: start }).transaction;
      tx.currentPhysicalRunner = { ...tx.currentPhysicalRunner!, phase: 'materializing', phaseEnteredAtMs: start,
        heartbeatAtMs: start, childScopeUnits: [unit], childScopeReservedAtMs: start };
      const held = JSON.stringify(tx.currentPhysicalRunner);
      // Only the business clock advances; every sample probes the same real OS scope.
      const passes = Math.ceil(QUALIFICATION_PROGRESS_STALE_MS / 120_000) + 2;
      for (let sequence = 1; sequence <= passes; sequence++) {
        expect(await probeRunnerLiveness(tx.currentPhysicalRunner!)).toBe('live');
        const result = observeQualificationProgress(tx, target, { fence: qualificationProgressFence(tx, target),
          observerGeneration: 'quiet-materialization', sequence, sampledAtMs: start + sequence * 120_000,
          monotonicAtMs: sequence * 120_000, telemetryHealthy: true });
        expect(result.status).toBe('updated');
        tx = result.transaction;
        expect(tx.progressObservation?.semantic).toBe('unknown');
        expect(JSON.stringify(tx.currentPhysicalRunner)).toBe(held);
        expect(tx.outcome.kind).toBe('pending');
        expect(running(pid)).toBe(true);
      }
      expect(tx.progressObservation).toMatchObject({ health: 'healthy', controller: 'silent', semantic: 'unknown' });
      expect(output).toBe('');
      expect(existsSync(receipt)).toBe(false);
      // A different phase binds a predeclared finite subtask population before its result.
      const suiteStart = Date.now();
      tx.currentPhysicalRunner!.phase = 'suite';
      tx.currentPhysicalRunner!.phaseEnteredAtMs = suiteStart;
      tx.continuation = { schemaVersion: 1, attemptId: tx.attemptId, candidate: tx.candidate!,
        repairHead: tx.repairHead, root: process.cwd(), taskKey: 'quiet-suite', retryStates: [],
        manifest: { schemaVersion: 1, units: [
          { id: 'test:declared-subtask', kind: 'test', path: 'quiet-subtask.test.ts' },
          { id: 'test:pending', kind: 'test', path: 'quiet-pending.test.ts' },
        ] }, receipts: [], supersededReceipts: [] };
      const sample = (sequence: number) => {
        tx = observeQualificationProgress(tx, target, { fence: qualificationProgressFence(tx, target),
          observerGeneration: 'quiet-suite', sequence, sampledAtMs: suiteStart + sequence * 1000,
          monotonicAtMs: sequence * 1000, telemetryHealthy: true }).transaction;
      };
      sample(1); sample(2);
      expect(tx.progressObservation?.semantic).toBe('unchanged');
      writeFileSync(trigger, 'complete declared subtask');
      await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 1000 });
      const result = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(result.pid).toBe(pid);
      delete result.pid;
      tx.continuation.receipts.push(result);
      sample(3);
      expect(tx.progressObservation).toMatchObject({ health: 'healthy', semantic: 'advancing',
        completedUnits: ['test:declared-subtask'] });
      expect(tx.currentPhysicalRunner?.childScopeUnits).toEqual([unit]);
      expect(await probeRunnerLiveness(tx.currentPhysicalRunner!)).toBe('live');
      expect(running(pid)).toBe(true);
      expect(tx.outcome.kind).toBe('pending');
      expect(output).toBe('');
      sample(4);
      expect(tx.progressObservation?.semantic).toBe('unchanged');
    } finally {
      markManagedSpawnTeardown(worker.child);
      await killScopeUnit(unit, { signal: 'SIGKILL' });
      await worker.waitForCompletion();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(['chatty', 'database-lock', 'blocked-controller'] as const)('bounds %s while a healthy peer completes', async mode => {
    const database = mode === 'database-lock' ? await createFreshTestDb({ prefix: 'qualification_stall' }) : undefined;
    const sql = database ? postgres(database.url, { max: 1, onnotice: () => {} }) : undefined;
    const stalledId = newTaskId(), healthyId = newTaskId(), units = [stalledId, healthyId].map(id => scopeUnitForTask(id));
    const controller = new AbortController();
    let workerPid = 0, backendPid = 0, backendCheckInterval = '', output = '', diagnostics = '', messages = 0, spawnedAt = 0, releasedAt = 0;
    const connection = buildConnectionOptions({ searchPath: 'public', applicationName: 'qualification-stalled-worker',
      idleInTxMs: 2000, stmtTimeoutMs: 0, pooled: false, clientConnCheckMs: 100 });
    const release = vi.fn<typeof recordStoredQualificationChildScope>(async (_target, change) => {
      if (change.operation === 'release' && change.unit === units[0]) {
        expect(workerPid).toBeGreaterThan(0);
        expect(running(workerPid)).toBe(false);
        releasedAt = Date.now();
      }
      return { status: 'updated', transaction: {} } as Awaited<ReturnType<typeof recordStoredQualificationChildScope>>;
    });
    const options = (taskKey: string): QualificationCommandOptions => ({
      target: { workspaceId: 'qualification-stall-test', installSlug: 'qualification-stall-test' },
      progress: { attemptId: 'test', candidate: 'test', repairHead: null, runnerId: 'test', runId: 'test',
        pidIdentity: 'test', root: process.cwd(), taskKey, runnerIdentity: 'test', updates: [],
        manifest: { schemaVersion: 1, units: [{ id: 'test:worker', kind: 'test', path: 'worker' }] },
        retryStates: [], runContext: 'green-checkpoint' },
      // Startup-hook coverage lives in checkpoint-qualification-process.integration.test.ts.
      // These fixed 4s/6s budgets measure the driver/OS path after builtin startup.
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, signal: controller.signal,
      deadlineEpochMs: Date.now() + 15_000,
    });
    const deps = (id: string) => ({
      spawn: (cmd: string, args: readonly string[], spec: Parameters<typeof managedSpawn>[2], launch: Parameters<typeof managedSpawn>[3]) =>
        managedSpawn(cmd, args, spec, { ...launch, scopeAvailable: true }),
      record: release, kill: killScopeUnit, taskId: () => id, now: Date.now,
    });
    let stalled: Promise<unknown> | undefined;
    let cleanupCutoffEpochMs = 0;
    try {
      if (sql) await sql`SELECT pg_advisory_lock(42)`;
      const start = mode === 'database-lock' ? `
        const postgres = require('postgres');
        const client = postgres(process.env.QUALIFICATION_TEST_DB_URL, { max: 1, connection: ${JSON.stringify(connection)} });
        (async () => {
          const rows = await client.unsafe("SELECT pg_backend_pid() AS pid, current_setting('client_connection_check_interval') AS interval");
          console.log(JSON.stringify({ pid: process.pid, backendPid: rows[0].pid, backendCheckInterval: rows[0].interval }));
          setInterval(() => console.log('heartbeat without completed work'), 40);
          await client.unsafe('SELECT pg_advisory_lock(42)');
          process.exit(99);
        })().catch(error => { console.error('guarded worker failed', error.code ?? error.name); process.exit(98); });
      ` : mode === 'blocked-controller' ? `
        console.log(JSON.stringify({ pid: process.pid }));
        // Its controller event loop cannot send another heartbeat or inspect children.
        while (true) {}
      ` : `
        console.log(JSON.stringify({ pid: process.pid }));
        setInterval(() => console.log('heartbeat without completed work'), 40);
      `;
      // The independently fixed hang budget is 4s. Neither peer progress nor
      // chatter moves it. Optional idle expiry is tested separately: it can
      // expire during instrumentation startup before this hard-bound scenario.
      // D-008: the fixed 6s invocation cutoff includes 2s for guarded DB cleanup.
      // It never moves when output, a healthy peer or the OS release completes.
      cleanupCutoffEpochMs = Date.now() + 6000;
      stalled = runQualificationCommand(process.execPath, ['-e', start], {
        ...options('stalled'), deadlineEpochMs: cleanupCutoffEpochMs,
        env: { ...options('stalled').env, ...(database ? { QUALIFICATION_TEST_DB_URL: database.url } : {}) },
        hardTimeoutMs: 4000,
        onSpawn() { spawnedAt = Date.now(); },
        onOutput(stream, text) {
          if (stream !== 'stdout') { diagnostics += text; return; }
          output += text; messages++;
          if (!workerPid && output.includes('\n')) {
            const identity = JSON.parse(output.split('\n')[0]!);
            workerPid = identity.pid; backendPid = identity.backendPid ?? 0;
            backendCheckInterval = identity.backendCheckInterval ?? '';
          }
        },
      }, deps(stalledId));
      // Attach immediately even when an earlier readiness assertion fails.
      const outcome = stalled.then(() => null, error => error);
      await vi.waitFor(() => expect(workerPid, diagnostics).toBeGreaterThan(0), { timeout: 3000 });
      if (sql) expect(backendCheckInterval).toBe('100ms');
      if (sql) await vi.waitFor(async () => {
        const rows = await sql`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${backendPid}`;
        expect(rows[0]).toMatchObject({ wait_event_type: 'Lock', wait_event: 'advisory' });
      }, { timeout: 1500 });
      const healthy = await runQualificationCommand(process.execPath, ['-e', "console.log('completed healthy work')"],
        options('healthy'), deps(healthyId));
      expect(healthy).toMatchObject({ code: 0, signal: null });
      expect(healthy.stdout).toContain('completed healthy work');
      expect(running(workerPid)).toBe(true);
      if (mode === 'blocked-controller') {
        const heartbeatAtMs = spawnedAt;
        const fixture = beginQualificationTransaction(null, { attemptId: 'blocked-attempt',
          candidate: 'blocked-candidate', nowMs: heartbeatAtMs }).transaction;
        let tx: CheckpointQualificationTransaction = { ...fixture, phase: 'running', runId: 'blocked-run',
          currentPhysicalRunner: { id: 'blocked-runner', candidate: 'blocked-candidate', reservedAtMs: spawnedAt,
            unit: units[0], childScopeUnits: [units[0]!], childScopeReservedAtMs: spawnedAt,
            pid: workerPid, pidIdentity: checkpointPidIdentity(workerPid),
            phase: 'suite', phaseEnteredAtMs: spawnedAt, heartbeatAtMs, evidenceRefs: [] } };
        expect(parseCheckpointQualificationTransaction(tx), 'blocked controller fixture must pass the stored schema').not.toBeNull();
        const sqlFixture = (async () => [{ install_slug: 'blocked-install', workspace_id: 'blocked-workspace',
          marker: null, alarmed_key: null, progress_alarmed_key: null, qualification: tx }]) as unknown as Sql;
        const broadcast = vi.fn(async (_event: { conditionKey?: string }) => true);
        // Only the elapsed business clock is injected; the blocked OS process,
        // independent scope probe and external sweep execute on real event loops.
        await sweepLostGateRuns(sqlFixture, { nowMs: heartbeatAtMs + QUALIFICATION_PROGRESS_STALE_MS + 1,
          monotonicAtMs: 1000, observerGeneration: 'external-observer', observerSequence: 1,
          probeQualificationRunner: runner => probeRunnerLiveness(runner),
          recordProgressObservation: async (target, sample) => {
            const result = observeQualificationProgress(tx, target, sample);
            tx = result.transaction;
            return result;
          },
          claim: async () => true, readHolder: async () => null, hostFleetSlug: null,
          broadcast, notifyOwner: async () => {}, attention: { resolve: async () => true } });
        expect(tx.progressObservation).toMatchObject({ health: 'baseline', controller: 'silent', semantic: 'unknown' });
        expect(broadcast).toHaveBeenCalledOnce();
        expect(broadcast.mock.calls[0]?.[0]).toMatchObject({ conditionKey: 'green-checkpoint-run-progress:blocked-install' });
        expect(running(workerPid)).toBe(true); // observation did not stop or release the worker
      }
      expect(await outcome).toMatchObject({ message: 'qualification-worker-hard-timeout' });
      if (mode !== 'blocked-controller') expect(messages).toBeGreaterThan(2);
      expect(releasedAt - spawnedAt).toBeGreaterThanOrEqual(3900);
      expect(releasedAt - spawnedAt).toBeLessThan(6000);
      expect(running(workerPid)).toBe(false);
      if (sql) {
        expect(Date.now()).toBeLessThan(cleanupCutoffEpochMs);
        await vi.waitFor(async () => {
          expect(await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${backendPid}`).toEqual([]);
        }, { timeout: Math.max(1, cleanupCutoffEpochMs - Date.now()), interval: 25 });
        expect(Date.now()).toBeLessThanOrEqual(cleanupCutoffEpochMs);
      }
    } finally {
      controller.abort();
      await Promise.allSettled(units.map(unit => killScopeUnit(unit, { signal: 'SIGKILL' })));
      await Promise.allSettled(stalled ? [stalled] : []);
      if (sql) { await sql`SELECT pg_advisory_unlock(42)`; await sql.end({ timeout: 5 }); }
      await database?.drop();
    }
  }, 30_000);
});
