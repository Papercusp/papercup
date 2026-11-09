/** WI2457: exercise custody and finalization in the maintained private runtime. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filePath = 'packages/operator-core/lib/release/checkpoint-qualification-background-runtime.integration.test.ts';
const custodyTest = 'packages/operator-core/lib/dbos/dbos-executor-reaper-queue-liveness.integration.test.ts';
const terminalTest = 'packages/operator-core/lib/release/checkpoint-qualification-terminal-outcomes.integration.test.ts';
const reaperSource = 'packages/operator-core/lib/dbos/dbos-executor-reaper.ts';
const transactionSource = 'packages/operator-core/lib/release/checkpoint-qualification-transaction.ts';
const options = isolatedTestFileWorkerOptions(process.env, 3);
const selectors = ['qualification custody survives generic DBOS reaping',
  'durable-before-ack', 'after-ack: terminal replay', 'delivered-before-receipt'];
const healthTest = 'packages/operator-core/lib/release/watchdog-health.integration.test.ts';
const processTest = 'packages/operator-core/lib/release/checkpoint-qualification-process.integration.test.ts';
const stalledTest = 'packages/operator-core/lib/release/checkpoint-qualification-stalled-process.integration.test.ts';
const healthSource = 'packages/operator-core/lib/release/watchdog-health.ts';
const observerSource = 'packages/operator-core/lib/release/lost-gate-run-alarm.ts';

const runtimeCases = [
  { title: 'retains qualification custody and reconciles terminal effects in the observed private background runtime',
    managedTasks: false, selectors,
    checks: [[custodyTest, reaperSource, 15], [terminalTest, transactionSource, 5]] as const },
  { title: 'observes blocked controllers, observer recovery and exact process custody in the private background runtime',
    managedTasks: true,
    selectors: ['recordWatchdogPassOutcome \\(real PG\\)', 'qualification real process bounds',
      'qualification independent stalled-process bounds'],
    checks: [[healthTest, healthSource, 13], [processTest, transactionSource, 7],
      [stalledTest, observerSource, 5]] as const },
] as const;

// Register literal titles: parameter formatting truncates long object values and
// would change the existing canonical selector as well as the new case's name.
for (const { title, managedTasks, selectors: selected, checks } of runtimeCases) {
it(title, async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [...checks.flatMap(([testFile, sourceFile]) => [testFile, sourceFile]),
      observerSource, healthSource,
      'packages/operator-core/lib/release/checkpoint-qualification-terminal-events.ts',
      'packages/operator-core/lib/release/gate-action-receipt.ts',
      'packages/operator-core/lib/events/reaction-dedup.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/test-receipts.ndjson', 'phases/execute/executed-source-map.json'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'test-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', ...(managedTasks ? ['--managed-tasks'] : []),
        '--', process.execPath, join(root, 'scripts/test-files.mjs'),
        ...checks.map(([testFile]) => testFile), '--', '-t', selected.join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_GROUP: randomUUID(),
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'papercusp-workspace',
          PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'executed-source-map.json'),
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-qualification-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-qualification-canary.sock',
        },
      });
      observe(child);
      child.on('message', (message: { kind?: string; childPid?: number; pgPort?: number }) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          expect(env).not.toHaveProperty('OPENAI_API_KEY');
          expect(env).not.toHaveProperty('PAPERCUSP_SUBSTRATE_IPC_SOCKET');
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(env.PAPERCUSP_HOME).toBe(join(env.HOME!, '.papercusp'));
          expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('1');
          if (managedTasks) expect(env.DBUS_SESSION_BUS_ADDRESS).toContain(env.XDG_RUNTIME_DIR);
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          environmentObserved = true;
        } catch (error) { environmentError = error; }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const maps = JSON.parse(readFileSync(join(evidenceDir, 'executed-source-map.json'), 'utf8')).rows;
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        for (const [testFile, sourceFile, passed] of checks) {
          const evidence = maps.find((row: { testFile: string }) => row.testFile === testFile)?.sourceEvidence;
          expect(evidence?.status, testFile).toBe('stable');
          expect(evidence.sources.find((source: { path: string }) => source.path === sourceFile), testFile)
            .toMatchObject({ basis: 'vite-pre-transform',
              sha256: createHash('sha256').update(readFileSync(join(root, sourceFile))).digest('hex') });
          expect(rows.find(row => row.filePath === testFile), testFile).toMatchObject({ outcome: 'inserted',
            row: { status: 'pass', executionDetails: { passed, failed: 0, collectionFailed: false } } });
        }
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  // The shared helper verifies original child identity, private state and teardown.
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
}
