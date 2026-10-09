/** Actual current-source HTTP MCP client, private operator identity and PostgreSQL. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('managed capability acceptance over the production HTTP route', () => {
  it('retains kernel/browser/PTY state across fresh clients and refuses foreign handles', async () => {
    const root = resolve(__dirname, '../../../../..');
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        resolve(__dirname, '__fixtures__/managed-api-client.mts')], {
        cwd: root, env: { ...process.env, TMPDIR: '/dev/shm' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-30_000); });
      const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolveResult({ code, output }); });
    });
    expect(result.code, result.output).toBe(0);
    const line = result.output.split('\n').find(row => row.startsWith('MANAGED_API_PROOF='));
    expect(line, result.output).toBeDefined();
    expect(JSON.parse(line!.slice('MANAGED_API_PROOF='.length))).toMatchObject({
      transport: 'http', kernel: 'retained-across-clients', browser: 'retained-across-clients',
      pty: 'retained-across-clients', foreignHandles: 'refused', nativeCutover: 'unchanged',
    });
  }, 200_000);
});
