import { fork } from 'node:child_process';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type {} from '../../../test/governance-http-fixture';
import { expect, it } from 'vitest';
import { recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');

it('ratifies through the production HTTP plans door and executes only the signed bounded action in a private runtime', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/governance-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/governance-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-event.ts',
      'packages/operator-core/lib/agent-tools/index.ts',
      'packages/operator-core/lib/endpoint-route/routes/admin/plans.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-authentication.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-round.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-voting.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-certificate-source.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-gate.ts',
      'packages/operator-core/lib/p2p/onchain-governance-bridge.ts',
      'packages/operator-core/lib/p2p/treasury-controls.ts',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      const environment: Record<string, string | undefined> = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0' };
      delete environment.PC_HEAVY_PREEMPT_READY_FILE;
      delete environment.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        resolve(root, 'packages/operator-core/test/governance-http-fixture.ts'),
      ], { cwd: root, env: environment, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let output = '';
      child.stdout!.on('data', chunk => {
        output += String(chunk);
        for (const line of String(chunk).split('\n')) {
          if (line.startsWith('[with-test-pg] operator-api stage ') || line.startsWith('GOVERNANCE_HTTP_PHASE ')) console.info(line);
        }
      });
      child.stderr!.on('data', chunk => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: string | null }>((done, fail) => {
        const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
        child.once('error', error => { clearTimeout(timer); fail(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
      });
      await writeFile(join(evidenceDir, 'worker.log'), output, { flag: 'wx' });
      expect(result, output.slice(-12_000)).toEqual({ code: 0, signal: null });
      const line = output.split('\n').find(row => row.startsWith('GOVERNANCE_HTTP_RECEIPT '));
      expect(line, output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('GOVERNANCE_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ pid: expect.any(Number), workspace: expect.stringMatching(/^test-runtime-/),
        httpRatified: true, forgedRefused: true, foreignRefused: true, conflictRefused: true,
        lateBallotRefused: true, pausedRefused: true, exactActionSubmissions: 1, replayed: true,
        adapter: 'isolated deterministic receipt; no chain transaction' });
      console.info('GOVERNANCE_HTTP_VERIFIED ' + JSON.stringify({ runId, ...receipt }));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, 210_000);
