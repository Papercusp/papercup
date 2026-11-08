import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type {} from '../test/plan-absorption-http-fixture';
import { preparePrivateOperatorApiBundle } from '../test/private-http-workspace-preflight';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const options = isolatedWorkerOptions(480_000);
it('absorbs a duplicate over private current-build HTTP while pending survivors still block consumers', async context => {
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/plan-absorption-current-build-http.integration.test.ts',
    sourcePaths: ['packages/operator-core/test/plan-absorption-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts', 'scripts/with-test-pg.mjs',
      'packages/operator-core/lib/plan-duplicate-absorption.ts',
      'packages/operator-core/lib/blocker-resolution-decision.ts',
      'packages/operator-core/lib/blocker-resolution-evidence.ts',
      'packages/operator-core/lib/blocker-resolution-persistence.ts',
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/agent-tools/plans/set-status.ts',
      'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/hono-host.ts'],
    prepare: async evidenceDir => {
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, { builder: { timeoutMs: 240_000, maxMs: 420_000 } });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared).toBeTruthy();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        PLAN_ABSORPTION_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/plan-absorption-http-fixture.ts'),
        `--prepared-api-sha=${prepared!.sha256}`, `--prepared-receipt-sha=${prepared!.receiptSha256}`],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('PLAN_ABSORPTION_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('PLAN_ABSORPTION_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PLAN_ABSORPTION_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
        abandonmentRefused: true, absorptionPersisted: true, pendingConsumerBlocked: true,
        actualCompletionReleased: true, producerCustodyPreserved: true, replayed: true });
      console.info('PLAN_ABSORPTION_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('PLAN_ABSORPTION_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
