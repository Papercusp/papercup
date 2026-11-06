/** Development component proof only; complete OS/SEC tuple qualification is separate. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const modulePath = fileURLToPath(new URL('./handler-seccomp.ts', import.meta.url));
const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

async function guest(body: string) {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { establishHandlerProcessRestrictions } from ${JSON.stringify(modulePath)};
    import { createRequire } from 'node:module';
    import { Worker } from 'node:worker_threads';
    import { spawnSync } from 'node:child_process';
    const require = createRequire(${JSON.stringify(modulePath)});
    const koffi = require('koffi');
    const libc = koffi.load('libc.so.6');
    const socket = libc.func('socket', 'int', ['int', 'int', 'int']);
    const close = libc.func('close', 'int', ['int']);
    const before = socket(1, 1, 0);
    if (before < 0) throw new Error('socket positive control failed');
    close(before);
    ${body}
  `], { env: { PATH: '/usr/bin:/bin' }, timeout: 30_000, maxBuffer: 64_000 });
  return JSON.parse(stdout.trim());
}

describe.runIf(supported)('handler final process restrictions (real libseccomp, dedicated child)', () => {
  it('denies external execution and native Unix/IPv4/IPv6 socket creation after the boundary', async () => {
    const result = await guest(`
      const beforeExec = spawnSync('/bin/true');
      if (beforeExec.status !== 0) throw new Error('exec positive control failed');
      const receipt = establishHandlerProcessRestrictions();
      const deniedExec = spawnSync('/bin/true');
      const sockets = [1, 2, 10].map(family => socket(family, 1, 0));
      console.log(JSON.stringify({ receipt, execCode: deniedExec.error?.code, sockets, alive: true }));
    `);
    expect(result.execCode).toBe('EPERM');
    expect(result.sockets).toEqual([-1, -1, -1]);
    expect(result.receipt).toMatchObject({ profile: 'linux-handler-process-v1', noNewPrivileges: true, synchronizedThreads: true });
    expect(result.alive).toBe(true);
  }, 40_000);

  it('synchronizes a pre-existing worker and permits a new runtime thread after clone3 fallback', async () => {
    const result = await guest(`
      const source = \`
        const { parentPort } = require('node:worker_threads');
        const { createRequire } = require('node:module');
        const koffi = createRequire(${JSON.stringify(modulePath)})('koffi');
        const socket = koffi.load('libc.so.6').func('socket', 'int', ['int', 'int', 'int']);
        parentPort.on('message', () => parentPort.postMessage(socket(1, 1, 0)));
        parentPort.postMessage('ready');
      \`;
      const oldWorker = new Worker(source, { eval: true });
      await new Promise(resolve => oldWorker.once('message', resolve));
      establishHandlerProcessRestrictions();
      const denied = new Promise(resolve => oldWorker.once('message', resolve));
      oldWorker.postMessage('probe');
      const oldSocket = await denied;
      const fresh = new Worker(source, { eval: true });
      await new Promise(resolve => fresh.once('message', resolve));
      const freshDenied = new Promise(resolve => fresh.once('message', resolve));
      fresh.postMessage('probe');
      const freshSocket = await freshDenied;
      await Promise.all([oldWorker.terminate(), fresh.terminate()]);
      console.log(JSON.stringify({ oldSocket, freshSocket, threadsWorked: true }));
    `);
    expect(result).toEqual({ oldSocket: -1, freshSocket: -1, threadsWorked: true });
  }, 40_000);
});
