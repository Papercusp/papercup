/** Installed OMP lifecycle with a local provider and the production MCP dispatcher. */
import { fork } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, inject, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, isolatedWorkerFailureDetail, isolatedWorkerReceipt,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { admitted, localPreflight, measureLifecycle } from '../test/omp-managed-native-lifecycle';
import { preparePrivateOperatorApiBundle } from '../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../..');
const filePath = 'packages/operator-core/lib/omp-managed-tools.native.integration.test.ts';
const privateMcpUrl = process.env.OMP_MANAGED_PRIVATE_MCP_URL;
// Preparation, native assertions, source verification and PG shutdown have
// separate allowances. The 180s assertion limit is also used by the census
// supervisor; an enclosing timer must contain all of those phases.
const nativeCaseTimeoutMs = 180_000;
const workerOptions = { ...isolatedWorkerOptions(nativeCaseTimeoutMs, process.env, nativeCaseTimeoutMs,
  {}, 600_000), testFileExecutionFromStdout: true as const };

if (privateMcpUrl) {
  it('preserves production MCP through admitted OMP launch, native resume, wake and version drift', async () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const token = process.env.OMP_MANAGED_PRIVATE_MCP_TOKEN!;
    expect(token).toBeTruthy();
    const retained = await measureLifecycle(privateMcpUrl, token, { ...admitted, cutoverStaging: {} }, false,
      { expectRestricted: false });
    const removed = await measureLifecycle(privateMcpUrl, token, admitted, true);
    const drift = await measureLifecycle(privateMcpUrl, token, { ...admitted,
      clientVersions: { omp: 'unvalidated-client-version' } }, false, { expectRestricted: false });
    const invoked = {
      retained: await measureLifecycle(privateMcpUrl, token, { ...admitted, cutoverStaging: {} }, false,
        { viaInvoke: true, expectRestricted: false }),
      removed: await measureLifecycle(privateMcpUrl, token, admitted, false, { viaInvoke: true }),
      drift: await measureLifecycle(privateMcpUrl, token, { ...admitted,
        clientVersions: { omp: 'unvalidated-client-version' } }, false,
        { viaInvoke: true, expectRestricted: false }),
    };
    expect(retained[0]!.hasNativeExecution).toBe(true);
    expect(drift[0]!.hasNativeExecution).toBe(true);
    for (const row of removed) {
      expect(row.hasNativeExecution).toBe(false);
      expect(row.nativeRefused).toBe(true);
      expect(row.names.filter((name: string) => !name.startsWith('mcp__')).sort())
        .toEqual(retained[0]!.names.filter((name: string) => name !== 'bash' && !name.startsWith('mcp__')).sort());
    }
    console.info('OMP_ADMITTED_LIFECYCLE ' + JSON.stringify({ retained, removed, drift, invoked }));
  }, nativeCaseTimeoutMs);
} else {
  // Preflight belongs to the retained runtime's prepare phase below. A separate
  // passing case has no runtime receipt and suppresses custody for the file.
  it('retains installed OMP production MCP removal and native lifecycle evidence', async context => {
    let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>>;
    const proof = recordIsolatedIntegrationProof({ root, filePath, signal: context.signal,
      minimumFileRunTimeoutMs: workerOptions.testTimeoutMs + workerOptions.killGraceMs + 20_000,
      sourcePaths: ['packages/operator-core/test/omp-managed-native-lifecycle.ts',
        'packages/operator-core/test/omp-managed-native-provider.ts',
        'packages/operator-core/test/omp-native-home.ts',
        'libs/papercusp/packages/orchestrator/src/managed-capability-policy.ts',
        'libs/papercusp/packages/orchestrator/src/invoke.ts',
        'apps/operator/scripts/psu-launcher.mjs', 'packages/operator-core/lib/events/await/wake-executor.ts',
        'packages/operator-core/test/staging-first-http-fixture.ts'],
      retainedArtifacts: ['phases/prepare/native-mcp-preflight.json', 'phases/execute/worker.log',
        'phases/execute/native-tool-surface.json', 'phases/execute/operator-mcp-receipt.json',
        'phases/execute/managed-tool-replies.ndjson'],
      prepare: async evidenceDir => {
        const preflight = await localPreflight(evidenceDir);
        await writeFile(join(evidenceDir, 'native-mcp-preflight.json'), JSON.stringify(preflight));
        prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
          builder: { timeoutMs: 240_000, maxMs: 420_000, env: { ...process.env, VITEST: 'true' } },
        });
      },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_SCENARIO: 'omp-managed-tools', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL', 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath, '--import', 'tsx',
          join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
          '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256,
        ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, { ...workerOptions, signal: context.signal }); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({
          code: 0, signal: null, timedOut: false, aborted: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        expect(result.output).toContain('OMP_PRODUCTION_MCP_VERIFIED');
        const line = isolatedWorkerReceipt(result.output, 'OMP_ADMITTED_LIFECYCLE');
        expect(line, 'Native lifecycle observations must be retained').toBeDefined();
        await writeFile(join(evidenceDir, 'native-tool-surface.json'), line!);
      },
    });
    // A test timeout aborts context.signal before its async body settles. Keep
    // the original proof alive through supervisor cleanup and result retention.
    context.onTestFinished(async () => { await proof.catch(() => {}); }, workerOptions.killGraceMs + 20_000);
    const runId = await proof;
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_OMP_MANAGED_SURFACE_PROOF_RUN ' + runId);
  }, workerOptions.testTimeoutMs);
}
