import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
// Include the ESM caller in this project's type check without running it here.
import type {} from '../test/runtime-blocker-condition-http-scenario.mts';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const options = isolatedWorkerOptions(600_000);

it('retains exact independent runtime binding approval and replay through the private operator API', async context => {
  const runId = await recordIsolatedIntegrationProof({ root, signal: context.signal,
    minimumFileRunTimeoutMs: options.testTimeoutMs,
    filePath: 'packages/operator-core/lib/runtime-blocker-condition.http.integration.test.ts',
    sourcePaths: ['scripts/operator-api-working-tree.mjs', 'scripts/with-test-pg.mjs',
      'packages/operator-core/test/working-tree-operator-api-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/runtime-blocker-condition-http-scenario.mts',
      'packages/operator-core/lib/runtime-blocker-condition.ts',
      'packages/operator-core/lib/external-blockers.ts', 'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/acceptance-author-identity.ts',
      'packages/operator-core/lib/agent-tools/work_items/set_blocker.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/conversations-post.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    retainedArtifacts: ['phases/execute/runtime-binding-http-requests.json'],
    execute: async (observe, evidenceDir) => {
      await writeFile(join(evidenceDir, 'runtime-binding-http-requests.json'), '[]', { flag: 'wx' });
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/operator-api-working-tree.mjs'), ['--',
        process.execPath, '--import', 'tsx/esm',
        join(root, 'packages/operator-core/test/runtime-blocker-condition-http-scenario.mts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, { ...options, signal: context.signal });
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const receiptLine = result.output.split('\n').find(line => line.startsWith('WORKING_TREE_OPERATOR_API_RECEIPT '));
      expect(receiptLine, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(receiptLine!.slice('WORKING_TREE_OPERATOR_API_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        health: { service: 'papercusp-operator', sha: expect.stringMatching(/^[a-f0-9]{7,64}$/) },
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), callerExit: 0, hostStopped: true,
        probe: { calledToolOk: true }, sourceSnapshot: { checked: expect.any(Number) } });
      expect(['3055', '3070', '3170', '3271']).not.toContain(new URL(receipt.base).port);
      const scenarioLine = result.output.split('\n').find(line => line.startsWith('RUNTIME_BINDING_HTTP_VERIFIED '));
      expect(scenarioLine, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const scenario = JSON.parse(scenarioLine!.slice('RUNTIME_BINDING_HTTP_VERIFIED '.length));
      expect(scenario).toMatchObject({ workspace: receipt.workspace, auditEntries: 1,
        reviewerAuthenticated: true, activeBlockerRetained: true, lifecycleUnchanged: true,
        selfApprovalRefused: true, alteredReceiptRefused: true, stalePinsRefused: true, replayed: true });
      const requests = JSON.parse(await readFile(join(evidenceDir, 'runtime-binding-http-requests.json'), 'utf8'));
      expect(requests.filter((entry: { name: string }) => entry.name === 'work_items:set_blocker').length)
        .toBeGreaterThanOrEqual(7);
      console.info('RUNTIME_BINDING_HTTP_RECEIPT ' + JSON.stringify({ runId, receipt, scenario }));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
