import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type {} from '../test/fixtures/agent-obligation-reminders-background';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  isolatedWorkerReceipt, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const fixture = 'packages/operator-core/test/fixtures/agent-obligation-reminders-background.ts';
const options = isolatedWorkerOptions(240_000);

it('retains a real private reminder past the retry cap and settles its exact late simulated host receipt', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-obligation-reminders-background.integration.test.ts',
    sourcePaths: [fixture, 'packages/operator-core/lib/agent-obligation-reminders.ts',
      'packages/operator-core/lib/agent-obligations.ts', 'packages/operator-core/lib/events/await/engine.ts',
      'packages/operator-core/lib/events/await/store.ts', 'packages/operator-core/lib/events/await/wake-executor.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'scripts/with-test-pg.mjs'],
    retainedArtifacts: ['phases/execute/reminder-background-receipt.json'],
    execute: async (observe, evidenceDir) => {
      const env = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        OBLIGATION_BACKGROUND_EVIDENCE_DIR: evidenceDir };
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', join(root, fixture)],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const captured = await captureIsolatedWorker(child, evidenceDir, options);
      expect(captured, isolatedWorkerFailureDetail(captured.output, captured)).toMatchObject({
        code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = isolatedWorkerReceipt(captured.output, 'OBLIGATION_BACKGROUND_RECEIPT');
      expect(line, isolatedWorkerFailureDetail(captured.output, captured)).toBeTruthy();
      const receipt = JSON.parse(line!);
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        pendingAttempt: 8, settledAttempt: 9, duplicateReminderCount: 1,
        channel: 'psu-socket-inject', turnProof: 'host-attested',
        hostReceiptSimulated: true, actualLlmConsumptionProved: false });
      expect(receipt.source).toHaveLength(4);
      expect(receipt.exposedPayloadSha256).toHaveLength(2);
      console.info('OBLIGATION_BACKGROUND_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('OBLIGATION_BACKGROUND_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
