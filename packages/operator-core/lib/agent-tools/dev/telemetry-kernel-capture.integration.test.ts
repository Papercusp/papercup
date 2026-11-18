import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(600_000);
const captureSources = [
  'packages/operator-core/lib/agent-tools/dev/telemetry.ts',
  'packages/operator-core/lib/agent-identities/idop-p001-baseline.ts',
  'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
  'packages/operator-core/lib/agent-tools/plans/plan-execution-guard.ts',
  'packages/operator-core/lib/connected-apps/enforce.ts',
  'packages/operator-core/lib/governance-policy/enforce.ts',
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('captures authenticated original kernel inputs on a containing private host and replays both source revisions', async context => {
  const expected = captureSources.map(path => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
  const runId = await recordIsolatedIntegrationProof({ root, signal: context.signal,
    minimumFileRunTimeoutMs: options.testTimeoutMs,
    filePath: 'packages/operator-core/lib/agent-tools/dev/telemetry-kernel-capture.integration.test.ts',
    sourcePaths: [...captureSources, 'packages/operator-core/lib/agent-identities/idop-kernel-capture-http-fixture.ts',
      'scripts/operator-api-working-tree.mjs', 'packages/operator-core/test/working-tree-operator-api-fixture.ts'],
    execute: async (observe, evidenceDir) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(resolve(root, 'scripts/operator-api-working-tree.mjs'), [
        '--', process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/lib/agent-identities/idop-kernel-capture-http-fixture.ts'),
      ], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, { ...options, signal: context.signal });
      expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('WORKING_TREE_OPERATOR_API_RECEIPT '));
      expect(line, result.output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('WORKING_TREE_OPERATOR_API_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), callerExit: 0, hostStopped: true,
        sourceSnapshot: { sha: expect.stringMatching(/^[a-f0-9]{7,40}$/) },
        probe: { calledToolOk: true } });
      expect(['3055', '3070', '3170', '3271']).not.toContain(new URL(receipt.base).port);
      // The maintained runner fences every compiler input against this exact
      // source snapshot. Also bind each capture dependency to the bytes accepted
      // before this run, rather than trusting a commit label or a later HEAD.
      const sourceCommit = execFileSync('git', ['rev-parse', '--verify', `${receipt.sourceSnapshot.sha}^{commit}`],
        { cwd: root, encoding: 'utf8', timeout: 15_000 }).trim();
      expect(sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      for (const source of expected) {
        const bytes = execFileSync('git', ['show', `${sourceCommit}:${source.path}`],
          { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 15_000 });
        expect(sha256(bytes), source.path).toBe(source.sha256);
      }
      const capture = JSON.parse(readFileSync(resolve(evidenceDir, 'idop-kernel-capture.json'), 'utf8'));
      expect(capture).toMatchObject({ ok: true, scope: 'original-host-self-kernel-permission-inputs',
        snapshot: { workspaceId: receipt.workspace }, provenance: { workspaceId: receipt.workspace } });
      const comparison = JSON.parse(readFileSync(resolve(evidenceDir, 'idop-kernel-comparison.json'), 'utf8'));
      expect(comparison).toMatchObject({ passed: true, unexpected: [], unusedManifest: [], differences: [] });
      expect(comparison.checked).toHaveLength(1);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('IDOP_KERNEL_CAPTURE_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
