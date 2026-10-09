// @vitest-environment node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const launcher = fileURLToPath(new URL('./psu-launcher.mjs', import.meta.url));
const env = {
  PATH: process.env.PATH ?? '',
  VTE_VERSION: '7600',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
};

describe('psu --terminal-check offline CLI', () => {
  it('prints guidance and exits without a control-plane connection', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', launcher, '--terminal-check'], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('offline diagnostic did not exit')); }, 8000);
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { error += data; });
      child.on('error', (failure) => { clearTimeout(timer); reject(failure); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`diagnostic exited ${code}: ${error}`));
        else resolve(output);
      });
    });
    expect(result).toContain('local, read-only');
    expect(result).toContain('alacritty -e psu');
    expect(result).toContain('No interactive stdin');
  }, 10_000);

  it.skipIf(process.platform === 'win32')('measures software flow control in the affected real terminal', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const child = pty.spawn('/bin/bash', [
        '-c', 'stty ixon; exec "$@"', 'terminal-check',
        process.execPath, '--import', 'tsx', launcher, '--terminal-check',
      ], { cwd: root, env, cols: 80, rows: 24 });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('interactive diagnostic did not exit')); }, 8000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode !== 0) reject(new Error(`interactive diagnostic exited ${exitCode}: ${output}`));
        else resolve(output);
      });
    });
    expect(result).toContain('Software flow control: enabled');
    expect(result).toContain('press Ctrl-Q');
    expect(result).toContain('stty -ixon');
  }, 10_000);
});
