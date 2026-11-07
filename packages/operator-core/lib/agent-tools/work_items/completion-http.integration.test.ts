import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { validatePrivateCompletionRequests } from '../../../test/private-completion-http-scenario';
import { preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it.for(['palette HTTP', 'authenticated MCP proxy'] as const)(
  'completes a report-only work item through %s after exact report readback',
  { timeout: options.testTimeoutMs }, async (transport, context) => {
  await validatePrivateCompletionRequests();
  let prepared: { sha256: string; receiptSha256: string } | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/work_items/completion-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-completion-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/work_items/complete.ts',
      'packages/operator-core/lib/agent-tools/work_items/create.ts',
      'packages/operator-core/lib/work-items.ts', 'packages/operator-core/lib/coord-lifecycle/records.ts',
      'packages/operator-core/lib/agent-tools/reports/publish.ts',
      'packages/operator-core/lib/agent-tools/reports/get.ts', 'packages/operator-core/lib/report-library.ts',
      'packages/operator-core/lib/capabilities/invoke.ts',
      'packages/operator-core/lib/agent-mcp-client.ts', 'apps/operator/lib/mcp-proxy/proxy.ts',
      'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts',
      'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    retainedArtifacts: ['phases/execute/completion-observation.json',
      'phases/execute/completion-readback.json',
      ...(transport === 'authenticated MCP proxy' ? ['phases/execute/completion-proxy.log',
        'phases/prepare/operator-api-build.log', 'phases/prepare/operator-api-build-result.json',
        'phases/prepare/operator-api-preflight.json', 'phases/prepare/hono-host.mjs.build-steps.jsonl'] : [])],
    prepare: transport === 'authenticated MCP proxy' ? async evidenceDir => {
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } });
    } : undefined,
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: transport === 'palette HTTP' ? 'private-completion' : 'private-completion-mcp',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        ...(prepared ? ['--prepared-api-sha=' + prepared.sha256,
          '--prepared-receipt-sha=' + prepared.receiptSha256] : [])],
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
      const line = result.output.split('\n').find(row => row.startsWith('PRIVATE_COMPLETION_HTTP_RECEIPT '));
      expect(line, result.output.slice(-5_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PRIVATE_COMPLETION_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        hostStopped: true, state: 'done', claimReleased: true, reportVerifiedBeforeClose: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        reportBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(receipt.completionElapsedMs).toBeLessThan(20_000);
      expect(receipt.requests.map((request: { name: string }) => request.name)).toEqual([
        'coord:whoami', 'work_items:create', 'reports:publish', 'reports:get', 'work_items:complete',
        ...(transport === 'authenticated MCP proxy' ? ['work_items:complete'] : []),
      ]);
      if (transport === 'authenticated MCP proxy') {
        expect(receipt).toMatchObject({ transport: 'mcp-proxy',
          replay: { tagged: true, originalHandlerExecutions: 1 } });
        expect([401, 403]).toContain(receipt.invalidBearerStatus);
      }
      console.info('PRIVATE_COMPLETION_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('PRIVATE_COMPLETION_HTTP_PROOF_RUN ' + runId);
});
