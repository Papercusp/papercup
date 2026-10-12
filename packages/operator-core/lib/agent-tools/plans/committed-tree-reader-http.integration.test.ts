import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('measures cold committed blobs through HTTP and preserves a real sidecar timeout while health advances', async context => {
  let prepared: ReturnType<typeof preparePrivateOperatorApiBundle> | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/committed-reader-http-scenario.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts',
      'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts',
      'packages/operator-core/lib/agent-tools/plans/get-spec-evidence.ts',
      'packages/operator-core/lib/fleet/git-via-sidecar.ts',
      'packages/operator-core/lib/fleet/spawner-ipc-client.ts',
      'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
      'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    prepare: async evidenceDir => {
      const sourceReceiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
      const selectedCommit = process.env.VERIFY_TAURI_SOURCE_REF;
      assert.ok(sourceReceiptPath && selectedCommit, 'Independent selected committed source receipt and ref are required');
      // Reuse the independent preparation receipt beside the source selection.
      // Missing/full-closure gaps refuse here, before allocating private PG.
      prepared = preparePrivateOperatorApiBundle(root, evidenceDir, { committedReader: {
        sourceReceiptPath, selectedCommit, receiptPath: join(dirname(sourceReceiptPath), 'operator-api-preflight.json'),
      } });
    },
    execute: async (observe, evidenceDir) => {
      assert.ok(prepared?.selectedSource, 'Committed reader preparation must precede private runtime allocation');
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'committed-reader', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      const failures = result.output.split('\n').filter(line => /STAGING_FIRST_HTTP_FAILURE|^Error:|AssertionError|operator-api preflight failed/.test(line));
      expect(result, failures.join('\n') || result.output.slice(-4_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('COMMITTED_READER_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('COMMITTED_READER_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' } });
      expect(receipt.requests.map((request: any) => request.action)).toEqual(['cold', 'warm', 'timeout', 'recovery']);
      console.info('COMMITTED_READER_HTTP_VERIFIED ' + JSON.stringify({ workspace: receipt.workspace,
        commit: receipt.commit, actions: receipt.requests.map((request: any) => ({ action: request.action,
          invocationId: request.ledger.id, counters: request.counters })) }));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('COMMITTED_READER_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
