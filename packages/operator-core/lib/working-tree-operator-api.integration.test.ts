/**
 * WI-6554700010048234: the commit-independent operator-API test route.
 *
 * Drives scripts/operator-api-working-tree.mjs end to end, the way an agent
 * does: the CLI bundles the CURRENT WORKING TREE, boots it on private ports
 * against a disposable migrated PG (with-test-pg --isolated-runtime=operator-api),
 * runs a caller command with the operator URL / MCP URL / bearer exported, then
 * tears the host down and prints a WORKING_TREE_OPERATOR_API_RECEIPT line.
 * The caller here proves the exported environment reaches a real request
 * against the private host rather than a live operator port.
 */
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(600_000);
const LIVE_OPERATOR_PORTS = ['3055', '3070', '3170'];

// Runs inside the private runtime as the CLI's caller command (`-- <caller>`).
const CALLER_SCRIPT = [
  "const base = process.env.PAPERCUSP_OPERATOR_URL ?? '';",
  "const mcp = process.env.PAPERCUSP_OPERATOR_MCP_URL ?? '';",
  "const bearer = process.env.PAPERCUSP_OPERATOR_BEARER ?? '';",
  "if (!base || !mcp.startsWith(base + '/api/mcp') || !bearer) process.exit(3);",
  "const health = await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(15000) })).json();",
  "console.log('WORKING_TREE_CALLER_SAW ' + JSON.stringify({ service: health.service ?? null, port: new URL(base).port }));",
].join('\n');

it('runs a caller against an operator bundled from the working tree on private ports, then tears it down', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/working-tree-operator-api.integration.test.ts',
    sourcePaths: ['scripts/operator-api-working-tree.mjs', 'scripts/with-test-pg.mjs',
      'scripts/lib/with-test-pg-env.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
      'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/working-tree-operator-api-fixture.ts',
      'packages/operator-core/lib/endpoint-route/routes/misc/health.ts',
      'packages/operator-core/lib/superuser-token.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      // The CLI owns the evidence dir layout (tmp/, node_modules symlink) when
      // WORKING_TREE_OPERATOR_API_EVIDENCE_DIR is set, so nothing is pre-created here.
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(resolve(root, 'scripts/operator-api-working-tree.mjs'), [
        '--', process.execPath, '--input-type=module', '-e', CALLER_SCRIPT,
      ], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });

      const rows = result.output.split('\n');
      const receiptLine = rows.find(row => row.startsWith('WORKING_TREE_OPERATOR_API_RECEIPT '));
      expect(receiptLine, result.output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(receiptLine!.slice('WORKING_TREE_OPERATOR_API_RECEIPT '.length));
      expect(receipt).toMatchObject({
        workspace: expect.stringMatching(/^test-runtime-/),
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: { service: 'papercusp-operator' },
        mode: 'caller', probe: null, callerExit: 0, hostStopped: true,
      });
      expect(LIVE_OPERATOR_PORTS).not.toContain(new URL(receipt.base).port);

      const sawLine = rows.find(row => row.startsWith('WORKING_TREE_CALLER_SAW '));
      expect(sawLine, result.output.slice(-8_000)).toBeTruthy();
      expect(JSON.parse(sawLine!.slice('WORKING_TREE_CALLER_SAW '.length))).toEqual({
        service: 'papercusp-operator', port: new URL(receipt.base).port,
      });
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('WORKING_TREE_OPERATOR_API_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);
