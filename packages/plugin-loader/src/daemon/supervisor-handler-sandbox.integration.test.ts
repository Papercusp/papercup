/** Actual Linux supervisor/bootstrap integration. Development proof only:
 * ldd here builds a TEST fixture, never a production inventory or SEC census.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlerRuntimeDigest, prepareHandlerRuntime, type HandlerRuntimeFile } from './handler-runtime';
import { startDaemonPlugin, type DaemonPluginHandle } from './supervisor';

const require = createRequire(import.meta.url);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

describe.runIf(supported)('mandatory handler supervisor (real bwrap + trusted TSYNC bootstrap)', () => {
  const base = new Map<string, HandlerRuntimeFile>();
  const handles: DaemonPluginHandle[] = [];
  let root: string;
  let sentinel: string;
  let bootstrap: Buffer;
  let seccompPath: string;
  const add = (path: string, contents: Buffer, executable = false) => base.set(path, { path, contents, executable, sha256: digest(contents) });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'handler-supervisor-'));
    sentinel = join(root, 'host-private');
    writeFileSync(sentinel, 'HOST_PRIVATE_CANARY');
    const { build } = await import('@papercusp/host-esbuild');
    const built = await build({ entryPoints: [fileURLToPath(new URL('./handler-bootstrap.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', write: false, external: ['koffi'] });
    bootstrap = Buffer.from(built.outputFiles![0]!.contents);
    add('/runtime/node', readFileSync(process.execPath), true);
    const libraries = (file: string) => {
      const text = execFileSync('/usr/bin/ldd', [file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      for (const path of new Set(text.match(/\/[^\s()]+/g) ?? [])) add(path, readFileSync(path), true);
    };
    libraries(process.execPath);
    const koffiRoot = dirname(require.resolve('koffi'));
    for (const path of ['package.json', 'index.cjs', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs']) {
      add('/runtime/node_modules/koffi/' + path, readFileSync(join(koffiRoot, path)));
    }
    const native = join(dirname(require.resolve('@koromix/koffi-linux-' + process.arch)), 'linux_' + process.arch, 'koffi.node');
    add('/runtime/node_modules/koffi/build/koffi/linux_' + process.arch + '/koffi.node', readFileSync(native), true);
    libraries(native);
    seccompPath = '/lib/' + (process.arch === 'x64' ? 'x86_64' : 'aarch64') + '-linux-gnu/libseccomp.so.2';
    add(seccompPath, readFileSync(seccompPath), true);
    libraries(seccompPath);
    add('/runtime/bootstrap.cjs', bootstrap);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(handles.map(handle => handle.shutdown()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function inventory(entry: string, omitSeccomp = false, alternateBootstrap?: Buffer) {
    const files = [...base.values()].filter(file => !omitSeccomp || file.path !== seccompPath)
      .map(file => ({ ...file }));
    if (alternateBootstrap) {
      const item = files.find(file => file.path === '/runtime/bootstrap.cjs')!;
      item.contents = alternateBootstrap; item.sha256 = digest(alternateBootstrap);
    }
    const contents = Buffer.from(entry);
    files.push({ path: '/handler/entry.cjs', contents, executable: false, sha256: digest(contents) });
    return { files, sha256: handlerRuntimeDigest(files), bootstrapSha256: digest(alternateBootstrap ?? bootstrap) };
  }

  const simpleEntry = 'console.error("HANDLER_STARTED"); exports.requests = { "fixture.echo": input => input };';
  const options = { pluginName: 'strict-handler-fixture', sandbox: 'handler' as const, cmd: [], cwd: '/', healthIntervalMs: 0,
    restart: { policy: 'never' as const }, handlerReadyTimeoutMs: 10_000 };

  it('rejects changed bytes, a substituted bootstrap pin and duplicate/forbidden mounts before spawning', () => {
    const changed = inventory(simpleEntry);
    changed.files.at(-1)!.contents = Buffer.from('throw new Error("SUBSTITUTED");');
    expect(() => prepareHandlerRuntime(changed)).toThrow(/file digest mismatch/);
    expect(() => prepareHandlerRuntime({ ...inventory(simpleEntry), bootstrapSha256: '0'.repeat(64) })).toThrow(/bootstrap identity/);
    const duplicate = inventory(simpleEntry); duplicate.files.push(duplicate.files[0]!);
    expect(() => prepareHandlerRuntime(duplicate)).toThrow(/runtime-file profile/);
    const forbidden = inventory(simpleEntry); forbidden.files[0] = { ...forbidden.files[0]!, path: '/etc/passwd' };
    expect(() => prepareHandlerRuntime(forbidden)).toThrow(/runtime-file profile/);
  });

  it('refuses forged custody, an omitted profile or caller command without a raw fallback', async () => {
    const logs: string[] = [];
    await expect(startDaemonPlugin({ ...options, handlerRuntime: { sha256: '0'.repeat(64) }, onLog: line => logs.push(line) }))
      .rejects.toThrow(/not prepared by this host/);
    const runtime = prepareHandlerRuntime(inventory(simpleEntry));
    await expect(startDaemonPlugin({ ...options, sandbox: undefined, handlerRuntime: runtime })).rejects.toThrow(/configuration/);
    await expect(startDaemonPlugin({ ...options, cmd: [process.execPath, '-e', 'console.error("RAW_FALLBACK")'], handlerRuntime: runtime }))
      .rejects.toThrow(/configuration/);
    expect(logs).toEqual([]);
  });

  it('executes startup only after final restrictions and denies native process/socket/host-file effects', async () => {
    const logs: string[] = [];
    const entry = `
      const fs = require('node:fs');
      const koffi = require('/runtime/node_modules/koffi');
      const libc = koffi.load('libc.so.6');
      const prctl = libc.func('prctl','int',['int','unsigned long','unsigned long','unsigned long','unsigned long']);
      const socket = libc.func('socket','int',['int','int','int']);
      const execve = libc.func('execve','int',['str',koffi.pointer('str'),koffi.pointer('str')]);
      const startup = { nnp: prctl(39,0,0,0,0), filter: prctl(21,0,0,0,0), dumpable: prctl(3,0,0,0,0) };
      console.error('HANDLER_STARTED');
      exports.requests = { 'fixture.probe': async () => {
        fs.writeFileSync('/tmp/allowed','permitted');
        let runtimeWrite; try { fs.writeFileSync('/handler/entry.cjs','changed'); } catch(error) { runtimeWrite = error.code; }
        const exec = execve('/runtime/node',['node',null],[null]);
        const execErrno = koffi.errno();
        const sockets = [1,2,10].map(family => socket(family,1,0));
        const { Worker } = require('node:worker_threads');
        const worker = new Worker(\`const { parentPort } = require('node:worker_threads');
          const koffi = require('/runtime/node_modules/koffi');
          const socket = koffi.load('libc.so.6').func('socket','int',['int','int','int']);
          parentPort.postMessage(socket(1,1,0));\`, { eval:true });
        const threadSocket = await new Promise((resolve,reject) => { worker.once('message',resolve); worker.once('error',reject); });
        await worker.terminate();
        const leaked = fs.readdirSync('/proc/self/fd').flatMap(fd => {
          try { return fs.readlinkSync('/proc/self/fd/'+fd).includes('memfd:handler-') ? [fd] : []; }
          catch(error) { if(error.code === 'ENOENT') return []; throw error; }
        });
        return { startup, exec, execErrno, sockets, threadSocket, runtimeWrite, leaked,
          hostVisible:fs.existsSync(${JSON.stringify(sentinel)}), control:fs.readFileSync('/tmp/allowed','utf8'),
          env:process.env.NODE_OPTIONS ?? null };
      }};
    `;
    const handle = await startDaemonPlugin({ ...options, handlerRuntime: prepareHandlerRuntime(inventory(entry)), onLog: line => logs.push(line) });
    handles.push(handle);
    try {
      expect(await handle.request('fixture.probe')).toEqual({ startup: { nnp: 1, filter: 2, dumpable: 0 },
        exec: -1, execErrno: 1, sockets: [-1,-1,-1], threadSocket: -1, runtimeWrite: 'EROFS', leaked: [],
        hostVisible: false, control: 'permitted', env: null });
      expect(logs).toContain('HANDLER_STARTED');
      expect(readFileSync(sentinel, 'utf8')).toBe('HOST_PRIVATE_CANARY');
    } finally { await handle.shutdown(); }
  }, 30_000);

  it('fails final bootstrap setup without executing an entry startup sentinel', async () => {
    const logs: string[] = [];
    await expect(startDaemonPlugin({ ...options, handlerRuntime: prepareHandlerRuntime(inventory(simpleEntry, true)), onLog: line => logs.push(line) }))
      .rejects.toThrow(/handler bootstrap refused/);
    expect(logs.join('\n')).not.toContain('HANDLER_STARTED');
    expect(readFileSync(sentinel, 'utf8')).toBe('HOST_PRIVATE_CANARY');
  }, 20_000);

  it('rejects an identity-mismatched readiness reply and never exposes a usable handle', async () => {
    // Deliberately invalid trusted bundle fixture tests the HOST readiness gate.
    const wrong = Buffer.from(`process.stdin.once('data', data => {
      const input=JSON.parse(data.toString());
      console.log(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{sha256:'wrong',nonce:input.params.nonce,receipt:{}}}));
    });`);
    await expect(startDaemonPlugin({ ...options, handlerRuntime: prepareHandlerRuntime(inventory(simpleEntry, false, wrong)) }))
      .rejects.toThrow(/readiness mismatch/);
  }, 20_000);

  it('restarts from the original host snapshot and repeats the restricted startup before readmission', async () => {
    const logs: string[] = [];
    const original = inventory(`
      const koffi = require('/runtime/node_modules/koffi');
      const socket = koffi.load('libc.so.6').func('socket','int',['int','int','int']);
      if(socket(1,1,0) !== -1) throw new Error('UNCONFINED_STARTUP');
      console.error('HANDLER_STARTED');
      exports.requests = { 'fixture.echo': input => input, 'fixture.exit': () => { setTimeout(()=>process.exit(2),20); return true; }};
    `);
    const runtime = prepareHandlerRuntime(original);
    original.files.at(-1)!.contents.fill(0); original.files.length = 0;
    const handle = await startDaemonPlugin({ ...options, handlerRuntime: runtime, restart: { policy: 'on-failure', maxRestarts: 1, backoffMs: 1 },
      onLog: line => logs.push(line) });
    handles.push(handle);
    try {
      const oldPid = handle.pid();
      expect(await handle.request('fixture.exit')).toBe(true);
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (handle.pid() !== oldPid && logs.filter(line => line === 'HANDLER_STARTED').length === 2) {
          try { ready = await handle.request<boolean>('fixture.echo', true, 200); if (ready) break; } catch { /* bootstrap still pending */ }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ready).toBe(true);
      expect(handle.restartCount()).toBe(1);
      expect(handle.pid()).not.toBe(oldPid);
      expect(logs).not.toContain('UNCONFINED_STARTUP');
    } finally { await handle.shutdown(); }
  }, 25_000);
});
