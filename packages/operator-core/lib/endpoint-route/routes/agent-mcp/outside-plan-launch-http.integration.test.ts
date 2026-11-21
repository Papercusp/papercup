import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../../test/isolated-integration-proof';
import { preparePrivateWorkerSources } from '../../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../../..');
const options = isolatedWorkerOptions(480_000);
const scenarioPaths = ['packages/operator-core/test/staging-first-http-fixture.ts',
  'packages/operator-core/test/outside-plan-launch-http-scenario.ts'];

it('serves the persisted outside-plan binding through current-build bootstrap and MCP HTTP', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/routes/agent-mcp/outside-plan-launch-http.integration.test.ts',
    sourcePaths: [...scenarioPaths, 'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/session-outside-plan.ts', 'packages/operator-core/lib/role-launch-spec.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su-resume.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/whoami.ts'],
    prepare: async () => { preparePrivateWorkerSources(root, scenarioPaths); },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, STAGING_FIRST_HTTP_SCENARIO: 'outside-plan-launch',
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, scenarioPaths[0]), '--private-http-scenario=outside-plan-launch'],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('OUTSIDE_PLAN_LAUNCH_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('OUTSIDE_PLAN_LAUNCH_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ bootstrapStatus: 200, mixedStatus: 400, overflowStatus: 400,
        conflictStatus: 400, resumeConflictStatus: 409, ordinaryStatus: 200,
        nativeLaunched: false, hostStopped: true, bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        planRef: '  outside:😀  ', whoamiPlanRef: '  outside:😀  ' });
      console.info('OUTSIDE_PLAN_LAUNCH_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('OUTSIDE_PLAN_LAUNCH_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
