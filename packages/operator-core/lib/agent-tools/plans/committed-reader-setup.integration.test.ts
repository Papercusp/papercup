import { fork } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(60_000);

it('measures private committed-reader fixture scope before bundling or HTTP execution', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'committed-reader-setup-'));
  const env = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
    STAGING_FIRST_HTTP_SCENARIO: 'committed-reader-setup', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
    process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
  { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const result = await captureIsolatedWorker(child, evidenceDir, options);
  expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
    timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'committed-reader-setup-receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
    bundleStarted: false, httpStarted: false, sidecarStarted: false });
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.visible).toHaveLength(1);
  console.info('COMMITTED_READER_SETUP_MEASURED ' + JSON.stringify({ evidenceDir, receipt }));
}, options.testTimeoutMs);
