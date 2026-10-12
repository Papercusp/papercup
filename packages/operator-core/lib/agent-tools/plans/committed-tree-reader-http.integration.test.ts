import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle, produceCommittedReaderOriginalPreparation,
  produceCommittedReaderPrivateApiBundle } from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('measures cold committed blobs through HTTP and preserves a real sidecar timeout while health advances', async context => {
  let prepared: ReturnType<typeof preparePrivateOperatorApiBundle> | undefined;
  const filePath = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts';
  const sourcePaths = ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/committed-reader-http-scenario.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/_org-test-db.ts',
      'packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts',
      'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts',
      'packages/operator-core/lib/agent-tools/plans/get-spec-evidence.ts',
      'packages/operator-core/lib/fleet/git-via-sidecar.ts',
      'packages/operator-core/lib/fleet/spawner-ipc-client.ts',
      'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
      'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts', 'scripts/source-preview.mjs',
      'packages/operator-core/lib/process-identity.ts'];
  const configPaths = ['package.json', 'packages/operator-core/package.json',
    'packages/operator-core/vitest.integration.config.ts', 'scripts/test-files.mjs'];
  const selectedCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const schemaDb = await createOrgTestDb();
  let schema: Record<string, string>;
  try {
    const columns = await schemaDb.adminSql`SELECT table_schema, table_name, column_name, data_type, udt_name,
      is_nullable, column_default, ordinal_position FROM information_schema.columns
      WHERE table_schema = 'harness_shared' ORDER BY table_name, ordinal_position`;
    schema = Object.fromEntries(columns.map(row => [
      `${row.table_schema}.${row.table_name}.${row.column_name}`,
      createHash('sha256').update(JSON.stringify({ ...row })).digest('hex'),
    ]));
  } finally { await schemaDb.cleanup(); }

  const preparationParent = await mkdtemp(join(tmpdir(), 'committed-reader-original-'));
  try {
    const independentRoot = join(preparationParent, 'independent', 'source');
    const preparation = await produceCommittedReaderOriginalPreparation({
      repositoryRoot: root, workRoot: join(preparationParent, 'independent'), selectedCommit, testPath: filePath,
      helperPaths: sourcePaths, configPaths, schema,
      environment: { PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
        NODE_PATH: join(independentRoot, 'node_modules') },
    });
    const proofRoot = preparation.root;
    const runId = await recordIsolatedIntegrationProof({ root: proofRoot, filePath, sourcePaths,
      requiredPreparation: preparation.identity, prepare: async evidenceDir => {
        prepared = produceCommittedReaderPrivateApiBundle(proofRoot, evidenceDir, {
          sourceReceiptPath: preparation.sourceReceiptPath, inputReceiptPath: preparation.inputReceiptPath,
          selectedCommit: preparation.selectedCommit,
        });
        return preparation;
      },
      execute: async (observe, evidenceDir) => {
      assert.ok(prepared?.selectedSource, 'Committed reader preparation must precede private runtime allocation');
      await symlink(join(proofRoot, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'committed-reader', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(proofRoot, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(proofRoot, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256],
      { cwd: proofRoot, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  } finally { await rm(preparationParent, { recursive: true, force: true }); }
}, options.testTimeoutMs);
