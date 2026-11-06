/** Development component proof only; complete OS/SEC tuple qualification is separate. */
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHandlerBootstrapFilter } from './handler-seccomp';

const modulePath = fileURLToPath(new URL('./handler-seccomp.ts', import.meta.url));
const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

async function guest(body: string, ioUring = '0') {
  const filterFd = createHandlerBootstrapFilter();
  const source = `
    import { establishHandlerProcessRestrictions, loadAfterHandlerProcessRestrictions } from ${JSON.stringify(modulePath)};
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
  `;
  let child;
  try {
    // The broad read-only bind is only this component test fixture. The
    // production handler mount profile must restrict the visible filesystem.
    child = spawn('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--die-with-parent', '--seccomp', '3', '--',
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', source], {
      env: { PATH: '/usr/bin:/bin', UV_USE_IO_URING: ioUring }, timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe', filterFd],
    });
  } finally {
    closeSync(filterFd);
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { out += chunk; if (out.length > 64_000) child.kill('SIGKILL'); });
    child.stderr!.on('data', chunk => { err += chunk; if (err.length > 64_000) child.kill('SIGKILL'); });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve(out) : reject(new Error(`guest exited ${code}/${signal}: ${err}`)));
  });
  return JSON.parse(stdout.trim());
}

describe.runIf(supported)('handler final process restrictions (real libseccomp, dedicated child)', () => {
  it('seals the exported bootstrap filter against modification', () => {
    const fd = createHandlerBootstrapFilter();
    try {
      expect(fstatSync(fd).size).toBeGreaterThan(0);
      expect(() => writeSync(fd, new Uint8Array([0]), 0, 1, 0)).toThrow(/EPERM|permitted/);
    } finally {
      closeSync(fd);
    }
  });

  it('refuses an unsafe runtime before filter installation or handler import', async () => {
    const result = await guest(`
      let imported = false;
      let code;
      try { await loadAfterHandlerProcessRestrictions(async () => { imported = true; }); }
      catch (error) { code = error.code; }
      const stillAllowed = spawnSync('/bin/true').status;
      console.log(JSON.stringify({ imported, code, stillAllowed }));
    `, '1');
    expect(result).toEqual({ imported: false, code: 'handler-process-restriction-unavailable', stillAllowed: 0 });
  }, 40_000);

  it('denies external execution and native Unix/IPv4/IPv6 socket creation after the boundary', async () => {
    const result = await guest(`
      const beforeExec = spawnSync('/bin/true');
      if (beforeExec.status !== 0) throw new Error('exec positive control failed');
      const receipt = establishHandlerProcessRestrictions();
      const execve = libc.func('execve', 'int', ['str', koffi.pointer('str'), koffi.pointer('str')]);
      const execveat = libc.func('execveat', 'int', ['int', 'str', koffi.pointer('str'), koffi.pointer('str'), 'int']);
      const directExec = { result: execve('/bin/true', ['true', null], [null]), errno: koffi.errno() };
      const directExecAt = { result: execveat(-100, '/bin/true', ['true', null], [null], 0), errno: koffi.errno() };
      const deniedExec = spawnSync('/bin/true');
      const sockets = [1, 2, 10].map(family => socket(family, 1, 0));
      console.log(JSON.stringify({ receipt, directExec, directExecAt, execCode: deniedExec.error?.code, sockets, alive: true }));
    `);
    expect(result.directExec).toEqual({ result: -1, errno: 1 });
    expect(result.directExecAt).toEqual({ result: -1, errno: 1 });
    expect(result.execCode).toBe('EPERM');
    expect(result.sockets).toEqual([-1, -1, -1]);
    expect(result.receipt).toMatchObject({ profile: 'linux-handler-process-v1', noNewPrivileges: true, synchronizedThreads: true, ioUringDisabled: true });
    expect(result.alive).toBe(true);
  }, 40_000);

  it('synchronizes a pre-existing worker and permits a new runtime thread after clone3 fallback', async () => {
    const result = await guest(`
      const source = \`
        const { parentPort } = require('node:worker_threads');
        const { createRequire } = require('node:module');
        const koffi = createRequire(${JSON.stringify(modulePath)})('koffi');
        const libc = koffi.load('libc.so.6');
        const socket = libc.func('socket', 'int', ['int', 'int', 'int']);
        const close = libc.func('close', 'int', ['int']);
        parentPort.on('message', () => {
          const fd = socket(1, 1, 0);
          if (fd >= 0) close(fd);
          parentPort.postMessage(fd);
        });
        parentPort.postMessage('ready');
      \`;
      const oldWorker = new Worker(source, { eval: true, execArgv: ['--input-type=commonjs'] });
      await new Promise(resolve => oldWorker.once('message', resolve));
      const beforeProbe = new Promise(resolve => oldWorker.once('message', resolve));
      oldWorker.postMessage('positive control');
      if (await beforeProbe < 0) throw new Error('existing worker socket positive control failed');
      establishHandlerProcessRestrictions();
      const denied = new Promise(resolve => oldWorker.once('message', resolve));
      oldWorker.postMessage('probe');
      const oldSocket = await denied;
      const fresh = new Worker(source, { eval: true, execArgv: ['--input-type=commonjs'] });
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
