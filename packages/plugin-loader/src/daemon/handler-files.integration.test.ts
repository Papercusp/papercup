/** Linux mount/custody component proof, not complete SEC or installed-artifact acceptance. */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHandlerBwrapArgs } from './bwrap-args';
import { createHandlerBootstrapFilter, createHandlerReadonlyFile } from './handler-seccomp';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

describe.runIf(supported)('handler sealed exact-file guest mounts (real Linux)', () => {
  it('copies donor bytes, seals against writes and preserves an empty inventoried file', () => {
    const donor = Buffer.from('approved module bytes');
    const fd = createHandlerReadonlyFile(donor, digest(donor));
    const empty = createHandlerReadonlyFile(Buffer.alloc(0), digest(Buffer.alloc(0)));
    try {
      donor.fill(0);
      const actual = Buffer.alloc(21);
      expect(readSync(fd, actual, 0, actual.length, 0)).toBe(21);
      expect(actual.toString()).toBe('approved module bytes');
      expect(() => writeSync(fd, Buffer.from('changed'), 0, 7, 0)).toThrow(/EPERM|permitted/);
      expect(readFileSync(empty)).toHaveLength(0);
    } finally { closeSync(fd); closeSync(empty); }
  });

  it('runs the inventoried module without host files, startup hooks, writable runtime or extra descriptors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handler-mount-'));
    const sentinel = join(root, 'host-private');
    const preload = join(root, 'host-preload.cjs');
    const opened: number[] = [];
    writeFileSync(sentinel, 'HOST_PRIVATE_CANARY');
    writeFileSync(preload, 'throw new Error("HOST_STARTUP_HOOK_EXECUTED");');
    try {
      const filter = createHandlerBootstrapFilter(); opened.push(filter);
      const files: Array<{ path: string; fd: number; executable: boolean }> = [];
      const add = (path: string, bytes: Buffer, executable = false) => {
        const fd = createHandlerReadonlyFile(bytes, digest(bytes));
        opened.push(fd);
        files.push({ path, fd: opened.length + 2, executable });
      };
      add('/runtime/node', readFileSync(process.execPath), true);
      // Test fixture discovery only. Production receives an independently
      // inventoried/signed closure; it must never shell out to discover one.
      const libraries = execFileSync('/usr/bin/ldd', [process.execPath], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      for (const path of new Set(libraries.match(/\/[^\s()]+/g) ?? [])) add(path, readFileSync(path), true);
      add('/runtime/bootstrap.cjs', Buffer.from(`
        const fs = require('node:fs');
        let runtimeWrite;
        try { fs.writeFileSync('/handler/entry.cjs', 'changed'); runtimeWrite = 'ALLOWED'; }
        catch (error) { runtimeWrite = error.code; }
        fs.writeFileSync('/tmp/control', 'permitted');
        const leakedDescriptors = fs.readdirSync('/proc/self/fd').flatMap(fd => {
          try { const path = fs.readlinkSync('/proc/self/fd/' + fd); return path.includes('memfd:handler-') ? [path] : []; }
          catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        });
        console.log(JSON.stringify({ entry: require('/handler/entry.cjs'),
          hostVisible: fs.existsSync(${JSON.stringify(sentinel)}),
          secret: process.env.HANDLER_TEST_SECRET ?? null, options: process.env.NODE_OPTIONS ?? null,
          runtimeWrite, control: fs.readFileSync('/tmp/control','utf8'), leakedDescriptors }));
      `));
      add('/handler/entry.cjs', Buffer.from('module.exports = "authorized module executed";'));
      const built = buildHandlerBwrapArgs({ files, bootstrapFilterFd: 3 });
      const child = spawn(built.binary, built.argv, {
        env: { NODE_OPTIONS: '--require=' + preload, HANDLER_TEST_SECRET: 'HOST_ENV_CANARY' },
        stdio: ['ignore', 'pipe', 'pipe', ...opened], timeout: 30_000,
      });
      const result = await new Promise<string>((resolve, reject) => {
        let out = '', err = '';
        child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
        child.stdout!.on('data', chunk => { out += chunk; if (out.length > 64_000) child.kill('SIGKILL'); });
        child.stderr!.on('data', chunk => { err += chunk; if (err.length > 64_000) child.kill('SIGKILL'); });
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve(out) : reject(new Error(`guest ${code}/${signal}: ${err}`)));
      });
      expect(JSON.parse(result.trim())).toEqual({ entry: 'authorized module executed', hostVisible: false,
        secret: null, options: null, runtimeWrite: 'EROFS', control: 'permitted', leakedDescriptors: [] });
      expect(readFileSync(sentinel, 'utf8')).toBe('HOST_PRIVATE_CANARY');
    } finally {
      for (const fd of opened) closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
