import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const filePath = 'packages/operator-core/lib/agent-tools/git_sync/target-worker.integration.test.ts';
const fixture = 'packages/operator-core/test/git-sync-target-worker-fixture.ts';
const options = isolatedWorkerOptions(360_000);

it('routes a real authorized git-sync mutation to the exact private worker and removes private state', async context => {
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [fixture, 'scripts/with-test-pg.mjs',
      'apps/operator/lib/mcp-proxy/build-routing.ts', 'apps/operator/lib/mcp-proxy/proxy.ts',
      'packages/operator-core/lib/agent-tools/git_sync/run.ts',
      'packages/operator-core/lib/harness/git-sync/git-sync-action.ts',
      'packages/operator-core/lib/endpoint-ipc-discovery.ts',
      'packages/operator-core/lib/serving-build.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', resolve(root, fixture)], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FRICTION_WORKER_EVIDENCE: evidenceDir },
      });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, options);
      expect(result, result.output.slice(-6000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('FRICTION_WORKER_RECEIPT '));
      expect(line, result.output.slice(-6000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('FRICTION_WORKER_RECEIPT '.length));
      expect(receipt).toMatchObject({ committed: true, wrongTargetDispatched: false,
        principalDispatched: false, workerStopped: true, requestOnlyRefused: true });
      expect(receipt.workspace).toMatch(/^test-runtime-/);
      expect(existsSync(receipt.runtimeRoot)).toBe(false);
      console.info('FRICTION_WORKER_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
