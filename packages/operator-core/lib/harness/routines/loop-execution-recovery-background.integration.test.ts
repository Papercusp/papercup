/** Current-build acceptance for the accepted-successor guard race. Shared
 * bg-host adoption and deployed shipment require their own evidence. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const filePath = 'packages/operator-core/lib/harness/routines/loop-execution-recovery-background.integration.test.ts';
const assertion = 'packages/operator-core/lib/harness/routines/loop-execution-recovery.integration.test.ts';
const caseTitle = 'durable recovery against isolated Postgres > keeps an accepted successor reachable while its own bounded native-start observation begins';
const pattern = '^durable recovery against isolated Postgres keeps an accepted successor reachable while its own bounded native-start observation begins$';
const options = isolatedTestFileWorkerOptions(process.env, 1);

it('verifies the accepted-successor guard in an original isolated background worker with teardown', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [assertion,
      'packages/operator-core/lib/harness/routines/loop-execution-recovery.ts',
      'packages/operator-core/lib/harness/routines/loop-unreachable-guard.ts',
      'packages/operator-core/test/_org-test-db.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/lib/with-test-pg-cleanup.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/recovery-test-receipts.ndjson'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'recovery-test-receipts.ndjson');
      const environment: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
        PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
        PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
        OPENAI_API_KEY: 'forbidden-private-runtime-canary',
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-runtime-canary.sock' };
      // The encompassing router owns these barriers for its original lifetime.
      delete environment.PC_HEAVY_PREEMPT_READY_FILE;
      delete environment.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, resolve(root, 'scripts/test-files.mjs'),
        assertion, '--testNamePattern=' + pattern], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment,
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
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          environmentObserved = true;
        } catch { environmentError = new Error('private recovery worker environment isolation failed'); }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === assertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: 1, failed: 0, collectionFailed: false, passedCaseTitles: [caseTitle] } } });
        // This route selects one journey. The original complete 115-case source
        // proof remains separate; excluded cases cannot count as runtime passes.
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
        console.info('LOOP_RECOVERY_BACKGROUND_ACCEPTANCE ' + JSON.stringify({
          selectedCase: caseTitle, environmentObserved, testRunId: row.row.id,
          scope: 'isolated current-build background; shared bg-host adoption unmeasured',
        }));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
