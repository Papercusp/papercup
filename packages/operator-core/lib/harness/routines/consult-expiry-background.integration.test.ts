import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const filePath = 'packages/operator-core/lib/harness/routines/consult-expiry-background.integration.test.ts';
const assertions = [
  'packages/operator-core/lib/harness/routines/consult-expiry-action.test.ts',
  'packages/operator-core/lib/consult/consult-expiry-core.integration.test.ts',
];
const options = isolatedTestFileWorkerOptions(process.env, assertions.length);

it('recovers later consults and parks in an isolated background worker while a native launch is blocked', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [filePath, ...assertions,
      'packages/operator-core/lib/harness/routines/consult-expiry-action.ts',
      'packages/operator-core/lib/consult/consult-expiry-adapters.ts',
      'packages/operator-core/lib/consult/consult-expiry-core.ts',
      'packages/operator-core/lib/consult/consult-dispatch.ts',
      'packages/operator-core/lib/consult/cascade-core.ts',
      'packages/operator-core/lib/consult/get-feedback-prod.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/consult-expiry-receipts.ndjson'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'consult-expiry-receipts.ndjson');
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, resolve(root, 'scripts/test-files.mjs'), ...assertions], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-runtime-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-runtime-canary.sock' },
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
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          environmentObserved = true;
        } catch { environmentError = new Error('private consult expiry worker environment isolation failed'); }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        for (const assertion of assertions) {
          const receipt = rows.find(row => row.filePath === assertion);
          expect(receipt).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
            failed: 0, skipped: 0, collectionFailed: false,
          } } });
          expect(receipt.row.executionDetails.passed).toBeGreaterThan(0);
        }
        const wiring = rows.find(row => row.filePath === assertions[0]).row.executionDetails;
        expect(wiring.passedCaseTitles).toEqual(expect.arrayContaining([
          ...['cascade recovery', 'request recovery', 'due dispatch'].map(leg =>
            `consult expiry production wiring > finishes later rows and park recovery while ${leg} has a blocked launcher`),
        ]));
        const persisted = rows.find(row => row.filePath === assertions[1]).row.executionDetails;
        expect(persisted.passedCaseTitles).toContain(
          'sweepExpiredConsults — cascade advance (D-005/P-013) > keeps a deferred expiry launch queued while recovering a later overdue requester');
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
