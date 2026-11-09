import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, observeIsolatedWorkerLifetime,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle, preparePrivateWorkerSources, privateOperatorApiBuildBudget
} from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(60_000);

// Build observations deliberately cannot discharge the independent original
// preparation contract. Exercise the actual maintained host before adding any
// cohort adapter, keeping its unobserved dimensions in the retained receipt.
it('retains actual private API observations without qualifying missing preparation', async context => {
  const filePath = 'packages/operator-core/lib/agent-tools/plans/committed-reader-setup.integration.test.ts';
  const sourcePaths = ['packages/operator-core/test/staging-first-http-fixture.ts',
    'packages/operator-core/test/private-http-workspace-preflight.ts',
    'packages/operator-core/test/isolated-integration-proof.ts',
    'scripts/lib/vitest-startup-trace.mjs', 'libs/test-config/src/configuration-snapshot.ts',
    'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/hono-host.ts'];
  const selected = preparePrivateWorkerSources(root, [filePath, ...sourcePaths]);
  assert.ok(selected.frozenSource, 'Actual API observation requires an independently selected source archive');
  const observedSource = { sourceReceiptPath: selected.frozenSource.receiptPath,
    selectedCommit: selected.frozenSource.sourceCommit, sourceReceiptSha256: selected.frozenSource.receiptSha256 };
  const budget = privateOperatorApiBuildBudget();
  const workerOptions = isolatedWorkerOptions(60_000, process.env, 60_000, {}, budget.maxMs);
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>>;
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    retainedArtifacts: ['phases/prepare/verifier-source.json', 'phases/prepare/operator-api-inputs.json',
      'phases/prepare/operator-api-preflight.json', 'phases/execute/committed-reader-loaded-source.json',
      'phases/execute/committed-reader-host-config-inputs.json',
      'phases/execute/committed-reader-host-environment.json',
      'phases/execute/committed-reader-host-environment-terminal.json'],
    prepare: async evidenceDir => {
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, { observedSource, builder: budget });
      expect(prepared.qualification).toEqual({ status: 'pending' });
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'committed-reader-observation',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, workerOptions); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('COMMITTED_READER_OBSERVATION_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('COMMITTED_READER_OBSERVATION_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        qualification: 'pending', bundleSha256: prepared.sha256, health: { service: 'papercusp-operator' } });
      const observation = JSON.parse(await readFile(join(evidenceDir, 'committed-reader-loaded-source.json'), 'utf8'));
      expect(observation).toMatchObject({ pid: receipt.hostPid, exitObserved: true,
        sourceCommit: observedSource.selectedCommit });
      expect(observation.sources.length).toBeGreaterThan(0);
      expect(observation.pending).toEqual(expect.arrayContaining(['preparation-qualification',
        'module-evaluation', 'runtime-config', 'private-pg', 'sidecars', 'descendant-imports', 'complete-runtime-closure']));
      console.info('COMMITTED_READER_ACTUAL_OBSERVATION_VERIFIED ' + JSON.stringify({ runId: observation.runId,
        hostPid: receipt.hostPid, qualification: receipt.qualification, pending: observation.pending }));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, isolatedWorkerOptions(60_000, process.env, 60_000, {}, privateOperatorApiBuildBudget().maxMs).testTimeoutMs);

it.for([false, true])('binds through actual preparation and observes private cleanup on exception=%s without HTTP', { timeout: options.testTimeoutMs }, async exception => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'committed-reader-setup-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
    STAGING_FIRST_HTTP_SCENARIO: exception ? 'committed-reader-setup-exception' : 'committed-reader-setup',
    STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
    process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
  { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const observation = observeIsolatedWorkerLifetime(child, root, evidenceDir);
  const result = await captureIsolatedWorker(child, evidenceDir, options);
  expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: exception ? 1 : 0, signal: null,
    timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
  if (exception) expect(result.output).toContain('private preparation exception control');
  expect(observation.observationError).toBeUndefined();
  expect(observation.lifecycle?.workspace).toMatch(/^test-runtime-/);
  expect(observation.ended).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'committed-reader-setup-receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
    preparationPath: 'prepareCommittedReaderBindings',
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
  expect(receipt.bindings).toHaveLength(1);
  expect(receipt.bindingsBefore).toEqual(receipt.bindingsAfter);
  expect(receipt.bindingsAfter).toHaveLength(1);
  expect(receipt.requiredSchemaColumns).toEqual(['args_json', 'invoked_at', 'metadata_json', 'serving_process_id']);
  expect(result.output).not.toContain('STAGING_FIRST_HTTP_PHASE bundle-start');
  console.info('COMMITTED_READER_SETUP_MEASURED ' + JSON.stringify({ evidenceDir, receipt }));
});
