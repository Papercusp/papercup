/** Parking component proof on the maintained private background route.
 * Native transport remains mocked by the selected suites; this is not R-9's
 * live native pickup or deployed-artifact acceptance.
 */
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
const filePath = 'packages/operator-core/lib/consult/park-background-runtime.integration.test.ts';
const sourceWorkspace = '@papercusp/operator-core';
const checks = [
  {
    file: 'packages/operator-core/lib/consult/park.integration.test.ts',
    sources: ['packages/operator-core/lib/consult/park-adapters.ts',
      'packages/operator-core/lib/consult/park-prod.ts',
      'packages/operator-core/lib/consult/park-delivery-prod.ts'],
    titles: ['requires matching verdict pickup proof',
      'persisted owner-authority survives park creation and expiry',
      'adopt-alternative: an objection with an alternative wakes the parker',
      'silent-proceed: with no objection'],
  },
  {
    file: 'packages/operator-core/lib/events/await/wake-executor.test.ts',
    sources: ['packages/operator-core/lib/events/await/wake-executor.ts'],
    titles: ['books host-attested when the host confirmed a native turn start',
      'books host-attested when the host finds a durable exact-ID',
      'does not attest a turn on a host that was never asked',
      'does not attest a turn on a duplicate-delivery-id reply'],
  },
];
const options = isolatedTestFileWorkerOptions(process.env, checks.length);

it('verifies parking resolution and exact wake acknowledgements in the observed private background environment', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [...checks.flatMap(check => [check.file, ...check.sources]),
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/parking-test-receipts.ndjson', 'phases/execute/executed-source-map.json',
      'phases/execute/executed-source-map.1.json'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'parking-test-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, join(root, 'scripts/test-files.mjs'),
        ...checks.map(check => check.file), '--', '-t', checks.flatMap(check => check.titles).join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_GROUP: randomUUID(),
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: sourceWorkspace,
          PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'executed-source-map.json'),
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-parking-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-parking-canary.sock',
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
        const routerOutput = readFileSync(join(evidenceDir, 'worker.log'), 'utf8');
        const mapPaths = [...routerOutput.matchAll(/^TEST_FILE_SOURCE_MAP_OUT group=\S+ path=(.+)$/gm)]
          .map(([, encodedPath]) => JSON.parse(encodedPath!));
        expect(mapPaths.length).toBeGreaterThan(0);
        const maps = mapPaths.flatMap((mapPath: string) => {
          expect(resolve(dirname(mapPath))).toBe(resolve(evidenceDir));
          return JSON.parse(readFileSync(mapPath, 'utf8')).rows;
        });
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        for (const check of checks) {
          const mapped = maps.find((row: { testFile: string }) => row.testFile === check.file);
          expect(mapped?.workspaceName, check.file).toBe(sourceWorkspace);
          const evidence = mapped?.sourceEvidence;
          expect(evidence?.status, check.file).toBe('stable');
          for (const path of check.sources) {
            expect(evidence.sources.find((source: { path: string }) => source.path === path), path)
              .toMatchObject({ basis: 'vite-pre-transform',
                sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') });
          }
          const receipt = rows.find(row => row.filePath === check.file);
          expect(receipt, check.file).toMatchObject({ outcome: 'inserted', row: { status: 'pass',
            executionDetails: { passed: check.titles.length, failed: 0, collectionFailed: false } } });
          for (const title of check.titles) {
            expect(receipt.row.executionDetails.passedCaseTitles.some((passed: string) => passed.includes(title)), title)
              .toBe(true);
          }
        }
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
