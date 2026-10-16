/** Current-build reclaim acceptance through the maintained private background
 * runtime. Fixture effects and receipt writes never use the shared host state. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filePath = 'packages/operator-core/lib/storage/disk-reclaim-background-runtime.integration.test.ts';
const assertion = 'packages/operator-core/lib/storage/disk-reclaim.integration.test.ts';
const censusAssertion = 'packages/operator-core/lib/storage/disk-consumer-census.test.ts';
const censusSelected = [
  'accepts the real native directory-descent disappearance',
  'refuses unproven or incomplete disappearance evidence',
];
const selected = [
  'finishes an advancing root beyond its inspection allowance',
  'reaps an elevated census worker at its native deadline',
  'uses bounded privileged census and fd-safe removal',
  'native census handles delimiter-looking names',
  'native census retains a new write between planning',
  'persists start, exact removal intent, removed path and final receipt',
];
const options = isolatedTestFileWorkerOptions(process.env, 1);

it('reclaims private fixtures and reads back the exact durable receipt in the observed background runtime', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({
    root, filePath,
    sourcePaths: [assertion, censusAssertion, 'packages/operator-core/lib/storage/disk-reclaim.ts',
      'packages/operator-core/lib/storage/disk-consumer-census.ts',
      'packages/operator-core/lib/storage/retention-policy.ts',
      'packages/operator-core/lib/storage/retention-pins.ts',
      'scripts/lib/retention-pins.mjs', 'scripts/lib/fs-mutex.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/reclaim-test-receipts.ndjson'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'reclaim-test-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, join(root, 'scripts/test-files.mjs'),
        assertion, censusAssertion, '--', '-t', [...selected, ...censusSelected].join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-reclaim-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-reclaim-canary.sock',
        },
      });
      observe(child);
      child.on('message', (message: any) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          expect(env).not.toHaveProperty('OPENAI_API_KEY');
          expect(env).not.toHaveProperty('PAPERCUSP_SUBSTRATE_IPC_SOCKET');
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(env.PAPERCUSP_HOME).toBe(join(env.HOME!, '.papercusp'));
          expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('1');
          expect(env.PAPERCUSP_DBOS_ROUTINES).toBe('0');
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
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === assertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: selected.length, failed: 0, collectionFailed: false,
        } } });
        for (const title of selected) expect(row.row.executionDetails.passedCaseTitles.some(
          (passed: string) => passed.includes(title))).toBe(true);
        const census = rows.find(value => value.filePath === censusAssertion);
        expect(census).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: 6, failed: 0, collectionFailed: false,
        } } });
        for (const title of censusSelected) expect(census.row.executionDetails.passedCaseTitles.some(
          (passed: string) => passed.includes(title))).toBe(true);
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  // The maintained proof helper independently checks child identity, private
  // state writes, and runtimeRemoved/pgDataRemoved before returning this id.
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
