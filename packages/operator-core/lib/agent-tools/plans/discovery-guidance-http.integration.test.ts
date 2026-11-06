import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { validateDiscoveryGuidanceRequests } from '../../../test/discovery-guidance-http-scenario';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('delivers provisional, refusal, recovery and finalized discovery guidance to the same served session', async context => {
  await validateDiscoveryGuidanceRequests();
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/discovery-guidance-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/discovery-guidance-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/plans/product-shaping.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-declarations.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-declaration-resolvers.ts',
      'packages/operator-core/lib/plan-audits.ts', 'packages/operator-core/lib/agent-tools/plans/audit.ts',
      'packages/operator-core/lib/agent-tools/plans/new.ts', 'packages/operator-core/lib/agent-tools/plans/get.ts',
      'packages/operator-core/lib/agent-tools/plans/set-content.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'discovery-guidance', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n'))
          if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0,
        signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('DISCOVERY_GUIDANCE_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('DISCOVERY_GUIDANCE_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        actorPreserved: true, refusal: 'discovery_not_ready', recoveryTool: 'plans:set-content',
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
        stages: ['discovery', 'implementation-review', 'implementation-review'],
        initialGuidance: { stage: 'implementation' }, adoptedGuidance: { stage: 'implementation-review' },
        evidenceRefs: ['source:existing-discovery-guidance.ts'] });
      expect(new Set(receipt.transcript.map((row: any) => row.callerSid))).toEqual(new Set([receipt.callerSid]));
      console.info('DISCOVERY_GUIDANCE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('DISCOVERY_GUIDANCE_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
