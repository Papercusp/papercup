import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIsolatedScopeArgv,
  buildTaskScopeArgv,
  buildTaskServiceArgv,
  createSecretEnvironmentTransport,
  escapeSystemdServiceArgument,
  SYSTEMD_ENV_RUNNER_PATH,
} from './systemd-scope';
import {
  SYSTEMD_RUNNER_JOB_END_PREFIX,
  SYSTEMD_RUNNER_OUTPUT_PATH_ENV,
  SYSTEMD_RUNNER_REDACTIONS_ENV,
} from './systemd-scope-env-runner.mjs';

const PROPS = { unit: 'papercusp-bash-job-test.service', slice: 'papercusp-bash-job.slice' };

describe('transient service payload escaping', () => {
  it('escapes dollars for systemd while preserving Bash parameter expansions', () => {
    const command = 'false | cat; printf "PS0=[${PIPESTATUS[0]}] PID=[$$]\\n"';
    const argv = buildTaskServiceArgv(['/bin/bash', '-o', 'pipefail', '-c', command], PROPS);

    expect(argv.at(-1)).toBe(escapeSystemdServiceArgument(command));
    expect(argv.at(-1)).toContain('$${PIPESTATUS[0]}');
    expect(argv.at(-1)).toContain('[$$$$]');
    expect(argv.at(-1)).not.toBe(command);
  });

  it('leaves transient scope payloads byte-for-byte unchanged', () => {
    const command = 'printf "%s" "${PIPESTATUS[0]} $$"';
    const argv = buildTaskScopeArgv(['/bin/bash', '-c', command], {
      unit: 'papercusp-bash-job-test.scope',
      slice: 'papercusp-bash-job.slice',
    });

    expect(argv.at(-1)).toBe(command);
  });

  it('retains failed task units for the ledger writer while preserving collection by default', () => {
    const retained = buildTaskServiceArgv(['/bin/false'], {
      ...PROPS,
      collectFailedUnit: false,
    });
    expect(retained).not.toContain('--collect');
    expect(retained).not.toContain('--property=CollectMode=inactive-or-failed');

    const ordinary = buildTaskServiceArgv(['/bin/false'], PROPS);
    expect(ordinary).toContain('--collect');
    expect(ordinary).toContain('--property=CollectMode=inactive-or-failed');
  });

  it('enables systemd memory accounting whenever a task carries MemoryMax', () => {
    const argv = buildTaskServiceArgv(['/bin/false'], {
      ...PROPS,
      memoryMaxBytes: 32 * 1024 * 1024,
    });
    expect(argv).toContain('--property=MemoryAccounting=yes');
    expect(argv).toContain(`--property=MemoryMax=${32 * 1024 * 1024}`);
  });

  it('defaults memory-capped worker scopes to swap allowed; deny remains explicit', () => {
    const worker = buildIsolatedScopeArgv(['/bin/false'], 6);
    expect(worker).toContain('--property=MemoryMax=6G');
    expect(worker).not.toContain('--property=MemorySwapMax=0');

    const protectedOrchestrator = buildIsolatedScopeArgv(['/bin/false'], 6, 'deny');
    expect(protectedOrchestrator).toContain('--property=MemorySwapMax=0');
  });

  it('keeps a redacted file-backed service log after the live pipe reader disappears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'systemd-runner-output-'));
    const logPath = join(dir, 'durable.log');
    const secret = 'runner-reader-loss-secret-0123456789';
    const transport = createSecretEnvironmentTransport({
      PATH: process.env.PATH,
      RUNNER_TEST_SECRET: secret,
      [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath,
      [SYSTEMD_RUNNER_REDACTIONS_ENV]: Buffer.from(JSON.stringify([secret]), 'utf8').toString('base64'),
    });
    const script =
      `process.stdout.write('first:' + process.env.RUNNER_TEST_SECRET + '\\n');` +
      `setTimeout(() => process.stdout.write('second:' + process.env.RUNNER_TEST_SECRET + ` +
      `' internal=' + (process.env.${SYSTEMD_RUNNER_OUTPUT_PATH_ENV} || 'none') + '\\n'), 150);`;
    const child = spawn(
      process.execPath,
      [SYSTEMD_ENV_RUNNER_PATH, '--env-fd-path', transport.sourcePath, '--', process.execPath, '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner did not produce its first mirrored chunk')), 5_000);
        child.stdout?.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // Simulate the operator/systemd-run client disappearing. The runner's
      // stdout/stderr mirrors lose their readers, while its file sink remains.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];

      expect({ code, signal }).toEqual({ code: 0, signal: null });
      const output = readFileSync(logPath, 'utf8');
      expect(output).toContain('first:[REDACTED integration credential]');
      expect(output).toContain('second:[REDACTED integration credential] internal=none');
      expect(output).toContain(`${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=completed exit=0`);
      expect(output).not.toContain(secret);
    } finally {
      transport.release();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
