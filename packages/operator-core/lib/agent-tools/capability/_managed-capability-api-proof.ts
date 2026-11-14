/** Shared production HTTP proof; each canonical suite retains its own identity. */
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerReceipt } from '../../../test/isolated-integration-proof';
import type { recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle, privateMcpSourceSha } from '../../../test/private-http-workspace-preflight';

export function managedCapabilityApiProofOptions(
  filePath: `packages/operator-core/lib/agent-tools/capability/managed-capability-api.${'integration' | 'e2e'}.test.ts`
    | 'libs/papercusp/packages/orchestrator/src/managed-capability-matrix-real-client.integration.test.ts',
  scenario: 'parity' | 'offline-recovery' = 'parity',
): Parameters<typeof recordIsolatedIntegrationProof>[0] {
  const root = resolve(__dirname, '../../../../..');
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>>;
  return {
    root, filePath,
    sourcePaths: ['packages/operator-core/lib/agent-tools/capability/read-handler.ts',
      'packages/operator-core/lib/agent-tools/capability/patch.ts',
      'packages/operator-core/lib/agent-tools/capability/_managed-capability-api-proof.ts',
      'packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-client.mts',
      'packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-result.ts'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/managed-api-proof.json'],
    prepare: async evidenceDir => {
      const buildEnv: NodeJS.ProcessEnv = { ...process.env, VITEST: 'true' };
      const sourceSha = privateMcpSourceSha(root, buildEnv);
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        sourceSha,
        builder: { timeoutMs: 240_000, maxMs: 420_000, env: buildEnv },
      });
    },
    execute: async (observe, evidenceDir) => {
      await symlink(resolve(root, 'node_modules'), resolve(evidenceDir, 'node_modules'), 'dir');
      const childEnv: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir };
      for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
        'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
        'PAPERCUSP_TEST_RUNS_DB_URL']) delete childEnv[key];
      const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        resolve(__dirname, '__fixtures__/managed-api-client.mts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256,
        ...(scenario === 'offline-recovery' ? ['--offline-recovery-only'] : []),
      ], { cwd: root, env: childEnv, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir,
        isolatedTestFileWorkerOptions(childEnv, 1, {}, 'runtime')); }
      finally { await rm(resolve(evidenceDir, 'node_modules')); }
      expect(result.code, result.output).toBe(0);
      const cleanup = isolatedWorkerReceipt(result.output, 'MANAGED_API_CLEANUP');
      expect(cleanup, result.output).toBeDefined();
      expect(JSON.parse(cleanup!)).toMatchObject({ rows: scenario === 'offline-recovery' ? 0 : 1,
        processes: 'gone', browserRoots: 'gone', terminalRecorded: true });
      const line = isolatedWorkerReceipt(result.output, 'MANAGED_API_PROOF');
      expect(line, result.output).toBeDefined();
      const proof = JSON.parse(line!);
      if (scenario === 'offline-recovery') {
        expect(proof).toMatchObject({ transport: 'http', recovery: 'explicit-absent-route-refusals',
          positiveControl: 'original-file-read', effectControl: 'unchanged',
          scope: 'three-named-routes-only', installedClientJourney: 'not-executed' });
        expect(proof.checked).toEqual(['capability:offline_recovery', 'capability:local_recovery', 'capability:recovery']);
      } else {
        expect(proof).toMatchObject({ transport: 'http', kernel: 'retained-across-clients', browser: 'retained-across-clients',
          image: 'original-raster', patch: 'canonical-peer-lock-and-all-hunks',
          pty: 'refused-without-private-session-bus', foreignHandles: 'refused' });
      }
      await writeFile(resolve(evidenceDir, 'managed-api-proof.json'), JSON.stringify(proof));
    },
  };
}
