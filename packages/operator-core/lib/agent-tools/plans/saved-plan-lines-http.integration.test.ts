import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('repairs saved lines with real HTTP CAS and reads memory dry-run on the isolated current build', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/saved-plan-lines-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/saved-plan-lines-http-scenario.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/agent-tools/plans/backfill-dependency-edges.ts', 'packages/operator-core/lib/agent-tools/plans/plan-line-graph.ts',
      'packages/operator-core/lib/endpoint-route/routes/user/memory-relink-entities.ts', 'libs/generic/memory/src/relink-entities.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts', 'apps/operator/bin/hono-host.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'), '--saved-plan-lines'],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result.output, 'the private worker must select the requested verifier').toContain('SAVED_PLAN_LINES_HTTP_SELECTED');
      expect(result, result.output.slice(-6_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('SAVED_PLAN_LINES_HTTP_RECEIPT '));
      expect(line, result.output.slice(-6_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('SAVED_PLAN_LINES_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ hostStopped: true, graph: { represented: 22, added: 4, total: 26,
        stalePreviewRefused: true, existingRowsPreserved: true, externalEdgePreserved: true,
        idempotent: true, newRowsParked: true }, memory: { status: 200, dryRun: true, affectedMemories: 1, unchanged: true } });
      console.info('SAVED_PLAN_LINES_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
