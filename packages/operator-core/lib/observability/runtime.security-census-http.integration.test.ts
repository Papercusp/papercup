import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  isolatedWorkerReceipt, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle, privateMcpSourceSha } from '../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('binds an authenticated full census to the executed private API bundle without asserting population closure', async context => {
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/observability/runtime.security-census-http.integration.test.ts',
    sourcePaths: ['packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/security-census-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/observability/runtime.ts',
      'packages/operator-core/lib/coverage-census/security-qualification.ts',
      'packages/operator-core/lib/agent-tools/dev/telemetry.ts',
      'packages/operator-core/lib/plugin-host-runtime.ts', 'packages/plugin-loader/src/index.ts',
      'scripts/with-test-pg.mjs', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/hono-host.ts'],
    retainedArtifacts: ['phases/execute/security-census-proof.json', 'phases/execute/security-census-snapshot.json',
      'phases/execute/security-census-signed-receipt.json', 'phases/execute/worker.log'],
    prepare: async evidenceDir => {
      // Dirty availability bundles cannot supply boot artifact provenance.
      // Refuse before compilation/PG; test:file provides the pinned source route.
      privateMcpSourceSha(root);
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        builder: { timeoutMs: 240_000, maxMs: 420_000 },
      });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared).toBeTruthy();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'security-census', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        `--prepared-api-sha=${prepared!.sha256}`, `--prepared-receipt-sha=${prepared!.receiptSha256}`],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = isolatedWorkerReceipt(result.output, 'SECURITY_CENSUS_HTTP_RECEIPT');
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const proof = JSON.parse(line!);
      expect(proof).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: prepared!.sha256, sourcePins: expect.arrayContaining([
          expect.objectContaining({ path: 'packages/operator-core/lib/observability/runtime.ts' }),
          expect.objectContaining({ path: 'packages/plugin-loader/src/index.ts' }),
        ]), substitutionRefused: true, readbackVerified: true,
        populationComplete: false, closureAccepted: false, executionAdmitted: false });
      expect([401, 403]).toContain(proof.invalidBearerStatus);
      expect(proof.total).toBeGreaterThan(0);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ISOLATED_SECURITY_CENSUS_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
