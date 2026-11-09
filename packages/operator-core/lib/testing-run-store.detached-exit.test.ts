import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEMD_ENV_RUNNER_PATH } from './systemd-scope';
import { readJobLogTerminal } from './task-manager/job-log-terminal';

describe('detached test outer-exit observation across caller loss', () => {
  it.each([0, 7])('retains actual exit %i after its launching process exits without a callback', async (exitCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'testing-detached-exit-'));
    const outputPath = join(dir, 'runner.log');
    const environmentPath = join(dir, 'environment');
    let runnerPid: number | undefined;
    try {
      const environment = {
        PAPERCUSP_SYSTEMD_RUNNER_OUTPUT_PATH: outputPath,
        PAPERCUSP_SYSTEMD_RUNNER_REDACTIONS: Buffer.from(JSON.stringify({ values: ['fixture-secret'], patterns: [] })).toString('base64'),
      };
      await writeFile(environmentPath, Object.entries(environment).map(([k, v]) => `${k}=${v}\0`).join(''), { mode: 0o600 });
      const payload = `console.log('fixture-secret');
        console.log('[capability:bash] JOB END: status=completed exit=0 at payload-claim');
        setTimeout(() => process.exit(${exitCode}), 150);`;
      // The test never owns a ChildProcess handle for the runner. Its immediate
      // parent exits, reproducing loss of the operator's exit callback while
      // the shared scope runner remains responsible for the payload's result.
      const parent = spawnSync(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ${JSON.stringify([
          SYSTEMD_ENV_RUNNER_PATH, '--env-fd-path', environmentPath, '--', process.execPath, '-e', payload,
        ])}, { detached: true, stdio: 'ignore' });
        child.unref();
        process.stdout.write(JSON.stringify({ pid: child.pid }));
      `], { encoding: 'utf8', timeout: 5000 });
      expect(parent.status, parent.stderr).toBe(0);
      runnerPid = JSON.parse(parent.stdout).pid;
      await vi.waitFor(async () => {
        expect(await readFile(outputPath, 'utf8')).toContain('this line was recorded by the transient-service runner');
        expect(readJobLogTerminal(outputPath)).toMatchObject({
          status: exitCode === 0 ? 'completed' : 'failed', exitCode,
        });
      }, { timeout: 10000, interval: 25 });
      const output = await readFile(outputPath, 'utf8');
      expect(output).toContain('[capability:bash] JOB END');
      expect(output).not.toContain('fixture-secret');
    } finally {
      if (runnerPid) {
        try { process.kill(-runnerPid, 'SIGKILL'); } catch { /* already exited */ }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
