import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('refuses an undiscoverable gitlink inventory through current-build HTTP without publishing the admission', async context => {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/release/admission-current-build-http.integration.test.ts',
    sourcePaths: [
      'packages/operator-core/test/admission-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'scripts/with-test-pg.mjs',
      'packages/operator-core/lib/agent-tools/release/repair-queue.ts',
      'packages/operator-core/lib/release/admission-jobs.ts',
      'packages/operator-core/lib/release/admission-offthread.ts',
      'packages/operator-core/lib/release/admission-jobs.worker.ts',
      'packages/operator-core/lib/release/admission-fix-precheck.ts',
      'packages/operator-core/lib/release/admission-import-completeness.ts',
      'packages/operator-core/lib/release/frozen-candidate-repair-queue.ts',
      'scripts/lib/related-tests.mjs',
      'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts',
    ],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ADMISSION_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/admission-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('ADMISSION_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('ADMISSION_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('ADMISSION_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        queueUnchanged: true, lineageUnchanged: true, sourceUnchanged: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        response: { ok: false, admitted: false, refused: true, verdict: 'refused',
          reason: 'admission-precheck-unavailable', detail: expect.stringContaining('no discoverable test files') },
        health: { service: 'papercusp-operator' },
      });
      console.info('ADMISSION_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ADMISSION_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
