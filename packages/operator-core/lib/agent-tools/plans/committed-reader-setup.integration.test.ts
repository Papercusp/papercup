import { fork } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, observeIsolatedWorkerLifetime } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(60_000);

it('binds the private committed-reader item and refuses another Pot before bundling or HTTP execution', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'committed-reader-setup-'));
  const env = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
    STAGING_FIRST_HTTP_SCENARIO: 'committed-reader-setup', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
    process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
  { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const observation = observeIsolatedWorkerLifetime(child, root, evidenceDir);
  const result = await captureIsolatedWorker(child, evidenceDir, options);
  expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
    timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
  expect(observation.observationError).toBeUndefined();
  expect(observation.lifecycle?.workspace).toMatch(/^test-runtime-/);
  expect(observation.ended).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'committed-reader-setup-receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
    bundleStarted: false, httpStarted: false, sidecarStarted: false });
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.visible).toHaveLength(1);
  expect(receipt.exact).toHaveLength(1);
  expect(receipt.pot.state).toBe('exists');
  expect(receipt.resolvedPot).toBe(receipt.workspace);
  expect(receipt.rows[0]).toMatchObject({ workspace_id: receipt.workspace,
    harness_slug: receipt.scope.harnessSlug, feature_id: receipt.itemId });
  expect(receipt.binding.status).toBe('created');
  expect(receipt.wrongScope).toEqual({ workspaceId: receipt.workspace,
    harnessSlug: `${receipt.workspace}-wrong-pot` });
  expect(receipt.wrongBinding.status).toBe('work_item_not_found');
  console.info('COMMITTED_READER_SETUP_MEASURED ' + JSON.stringify({ evidenceDir, receipt }));
}, options.testTimeoutMs);
