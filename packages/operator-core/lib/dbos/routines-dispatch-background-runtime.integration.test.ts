/** Original private-runtime proof of cron selection and its durable admission clock. */
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
const filePath = 'packages/operator-core/lib/dbos/routines-dispatch-background-runtime.integration.test.ts';
const workflow = 'packages/operator-core/lib/dbos/routines-workflow.test.ts';
const database = 'libs/papercusp/libs/db/src/routines-runtime.integration.test.ts';
const source = 'packages/operator-core/lib/dbos/routines-workflow.ts';
const databaseSource = 'libs/papercusp/libs/db/src/routines-runtime.ts';
const selected = ['dispatches the overdue half-hour cohort', 'uses durable action admission clocks',
  'starts exactly the oldest starved routine', 'retains an action admission clock'];
const options = isolatedTestFileWorkerOptions(process.env, 2);

it('observes fair cron dispatch, durable action clocks and the single escape in a private background runtime', async context => {
  const runId = await recordIsolatedIntegrationProof({
    root, filePath, sourcePaths: [workflow, database, source, databaseSource,
      'packages/operator-core/lib/dbos/routines-queue-classification.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/dispatch-receipts.ndjson', 'phases/execute/executed-source-map.json',
      'phases/execute/executed-source-map.1.json'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'dispatch-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, join(root, 'scripts/test-files.mjs'), workflow, database, '--', '-t', selected.join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', PAPERCUSP_TEST_RUN_GROUP: randomUUID(),
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'papercusp-workspace',
          PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'executed-source-map.json'),
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts },
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        for (const [testFile, passed] of [[workflow, 4], [database, 1]] as const) {
          expect(rows.find(row => row.filePath === testFile)).toMatchObject({ outcome: 'inserted',
            row: { status: 'pass', executionDetails: { passed, failed: 0, collectionFailed: false } } });
        }
        for (const [mapName, testFile, changedSource] of [
          ['executed-source-map.json', workflow, source],
          ['executed-source-map.1.json', database, databaseSource],
        ]) {
          const map = JSON.parse(readFileSync(join(evidenceDir, mapName), 'utf8'));
          const original = map.rows.find((row: any) => row.testFile === testFile)?.sourceEvidence;
          expect(original?.status).toBe('stable');
          expect(original.sources.find((row: any) => row.path === changedSource)).toMatchObject({
            basis: 'vite-pre-transform', sha256: createHash('sha256').update(readFileSync(join(root, changedSource))).digest('hex') });
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  // The maintained observer verifies child identity, private writes and complete runtime/PG removal.
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
