import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayHash, replayLoadedRuntime, replayRuntimeLaunch, type ReplayRuntimeWitness } from './lsp-fleet-replay-runtime';
import { readProcessIdentity } from '../process-identity';
import { fileURLToPath } from 'node:url';
import { buildTaskScopeArgvWithTransport, SYSTEMD_ENV_RUNNER_PATH } from '../systemd-scope';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extension = 'mjs', source = 'console.log("executed");') {
  const root = mkdtempSync(join(tmpdir(), 'lsp-load-witness-')); roots.push(root);
  const entry = join(root, `entry.${extension}`);
  writeFileSync(entry, source);
  const launch = replayRuntimeLaunch(entry, root, 'witness-test');
  return { root, entry, launch };
}
function receipts(root: string) {
  const names = readdirSync(root).filter(name => name.endsWith('.jsonl'));
  return names.flatMap(name => readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
}
async function withLiveRuntime(f: ReturnType<typeof fixture>, check: (pids: number[], root: ChildProcess) => Promise<void> | void) {
  const child = spawn(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr!.on('data', chunk => { errors += chunk; });
  try {
    const pids = await new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime startup timeout: ${errors}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`runtime exited ${code}: ${errors}`)); });
      child.stdout!.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).pids); }
      });
    });
    await check([child.pid!, ...pids], child);
  } finally {
    // Each instrumented process has its own PID receipt; fixture teardown must
    // reap descendants too, including when the assertion before shutdown fails.
    for (const row of receipts(f.root).filter(row => row.kind === 'bootstrap')) {
      try { process.kill(row.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    child.kill();
    await closed;
  }
}
function liveWitness(f: ReturnType<typeof fixture>, files: string[]) {
  const library = '/test-native-mapping';
  const witness: ReplayRuntimeWitness = { directory: f.root, runId: 'witness-test',
    bootstraps: { [f.entry]: f.launch.evalSha256 },
    files: { ...Object.fromEntries(files.map(path => [path, replayHash(readFileSync(path))])), [library]: replayHash('fixture native') } };
  // Native mapping access is independently tested below. Here it is an explicit
  // fixture; cmdline, stat, process identity and source receipts are real.
  const reader = { identity: readProcessIdentity, link: () => '', bytes: () => Buffer.from('fixture native'),
    text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : readFileSync(path, 'utf8') };
  return { witness, reader };
}
describe('actual replay load-byte witness', () => {
  it('records the executed ESM bytes, config reads and argv-anchored bootstrap in a real Node process', () => {
    const f = fixture('mjs', 'import {readFileSync} from "node:fs"; console.log(readFileSync(new URL("./config.json",import.meta.url),"utf8"));');
    const config = join(f.root, 'config.json'); writeFileSync(config, '{"value":7}');
    expect(execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })).toContain('"value":7');
    const rows = receipts(f.root);
    expect(rows[0]).toMatchObject({ kind: 'bootstrap', evalSha256: f.launch.evalSha256 });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'esm-load-return', path: f.entry, sha256: replayHash(readFileSync(f.entry)) }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'file-read', path: config, sha256: replayHash(readFileSync(config)) }));
    expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
  });
  it('records the actual CommonJS compile source and JSON consumer bytes', () => {
    const f = fixture('cjs', 'console.log(require("./config.json").value);');
    const config = join(f.root, 'config.json'); writeFileSync(config, '{"value":9}');
    expect(execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })).toContain('9');
    const rows = receipts(f.root);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-compile', path: f.entry, sha256: replayHash(readFileSync(f.entry)) }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'json-load', path: config, sha256: replayHash(readFileSync(config)) }));
  });
  it('refuses preloads and later loader registration instead of claiming final executed bytes', () => {
    const f = fixture('mjs', 'import {registerHooks} from "node:module"; registerHooks({});');
    expect(() => execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '--no-warnings' }, stdio: 'pipe' })).toThrow();
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'unsupported-loader-or-preload' }));
    const second = fixture('mjs', 'import {registerHooks} from "node:module"; registerHooks({});');
    expect(() => execFileSync(process.execPath, second.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })).toThrow();
    expect(receipts(second.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'later-loader-registration' }));
  });
  it('retains an explicit unknown when a consumer bypasses complete file reads', () => {
    const f = fixture('cjs', 'const fs=require("node:fs"); const fd=fs.openSync(__filename,"r"); fs.readSync(fd,Buffer.alloc(4),0,4,0); fs.closeSync(fd);');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'unsupported-file-reader:readSync' }));
  });
  it('restores the reader guard after a default ESM load and a failed complete read', () => {
    const f = fixture('mjs', 'import fs from "node:fs"; try { fs.readFileSync("/missing-witness-fixture"); } catch {} const fd=fs.openSync(new URL(import.meta.url),"r"); fs.readSync(fd,Buffer.alloc(4),0,4,0); fs.closeSync(fd);');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root).filter(row => row.kind === 'unknown')).toEqual([
      expect.objectContaining({ reason: 'unsupported-file-reader:readSync' }),
    ]);
  });
  it('propagates through real forks and shebang grandchildren, preserving IPC, argv and memory flags', async () => {
    const f = fixture();
    const worker = join(f.root, 'worker.cjs');
    const leaf = join(f.root, 'leaf.cjs');
    writeFileSync(leaf, '#!/usr/bin/env node\nconsole.log(JSON.stringify({pid:process.pid,arg:process.argv[2]}));setInterval(()=>{},1000);', { mode: 0o700 });
    writeFileSync(worker, `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(leaf)},['leaf-argument'],{stdio:['ignore','pipe','pipe']});c.stdout.on('data',chunk=>process.send({leaf:JSON.parse(String(chunk)),worker:process.pid,argv:process.argv,execArgv:process.execArgv}));`);
    writeFileSync(f.entry, `import {fork} from 'node:child_process';const c=fork(${JSON.stringify(worker)},['worker-argument'],{silent:true,execArgv:['--max-old-space-size=128'],stdio:['pipe','pipe','pipe','ipc']});c.on('message',m=>{if(m.leaf.arg!=='leaf-argument'||m.argv[2]!=='worker-argument'||m.execArgv[0]!=='--max-old-space-size=128')throw Error('lost fork semantics');console.log(JSON.stringify({pids:[m.worker,m.leaf.pid]}));});`);
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, worker, leaf]);
      expect(pids).toHaveLength(3);
      for (const pid of pids) {
        const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
      }
      const workerRows = receipts(f.root).filter(row => row.pid === pids[1]);
      expect(workerRows[0]).toMatchObject({ parent: { pid: pids[0] }, ppid: pids[0] });
      expect(workerRows).toContainEqual(expect.objectContaining({ kind: 'child-launch', entry: leaf }));
      // Even adding a child hash to the trusted-root map cannot bypass a
      // missing parent launch or a wrong parent process epoch.
      const receiptPath = join(f.root, `${pids[0]}.jsonl`);
      const original = readFileSync(receiptPath, 'utf8');
      writeFileSync(receiptPath, original.split('\n').filter(line => !line || JSON.parse(line).kind !== 'child-launch').join('\n'));
      const childCommand = reader.text(`/proc/${pids[1]}/cmdline`).split('\0').filter(Boolean);
      const expanded = { ...witness, bootstraps: { ...witness.bootstraps, [worker]: workerRows[0].evalSha256 } };
      expect(replayLoadedRuntime(pids[1], reader.identity(pids[1]), childCommand, expanded, reader).unknown)
        .toContain('unwitnessed-runtime-bootstrap');
      writeFileSync(receiptPath, original);
      const wrongEpoch = { ...reader, identity: (pid: number) => pid === pids[0] ? 'another epoch' : reader.identity(pid) };
      expect(replayLoadedRuntime(pids[1], reader.identity(pids[1]), childCommand, witness, wrongEpoch).unknown)
        .toContain('unwitnessed-runtime-bootstrap');
    });
  }, 20_000);
  it('instruments the actual exact-env runner and its payload when the environment is replaced', async () => {
    const f = fixture();
    const runner = fileURLToPath(new URL('../systemd-scope-env-runner.mjs', import.meta.url));
    const environment = join(f.root, 'payload.env');
    const payload = join(f.root, 'payload.mjs');
    writeFileSync(environment, `PATH=${process.env.PATH}\0NODE_OPTIONS=\0WITNESS_EXACT=payload\0`);
    writeFileSync(payload, 'if(process.env.WITNESS_EXACT!=="payload"||process.env.WITNESS_OUTER)throw Error("env mismatch");console.log(JSON.stringify({pids:[process.ppid,process.pid]}));setInterval(()=>{},1000);');
    writeFileSync(f.entry, `import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(runner)},'--env-fd-path',${JSON.stringify(environment)},'--',process.execPath,${JSON.stringify(payload)}],{env:{...process.env,WITNESS_OUTER:'outer'},stdio:'inherit'});setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, runner, environment, payload]);
      for (const pid of pids) {
        const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
      }
      expect(receipts(f.root).filter(row => row.kind === 'bootstrap').map(row => row.entry).sort())
        .toEqual([f.entry, runner, payload].sort());
    });
  }, 20_000);
  it('retains unknown for an unsupported child loader rather than replacing its launch flags', () => {
    const f = fixture('mjs', 'import {spawn} from "node:child_process"; const c=spawn(process.execPath,["--import","data:text/javascript,", "--eval","console.log(1)"],{stdio:"ignore"});await new Promise(resolve=>c.on("exit",resolve));');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: `unsupported-child-launch:${process.execPath}` }));
  });
  it('propagates on the real managed systemd scope argv, including its nested runner separator', async () => {
    const f = fixture();
    const payload = join(f.root, 'scoped-payload.mjs');
    writeFileSync(payload, 'if(process.env.WITNESS_EXACT!=="scoped")throw Error("env mismatch");console.log(JSON.stringify({pids:[process.ppid,process.pid]}));setInterval(()=>{},1000);');
    const launch = buildTaskScopeArgvWithTransport([process.execPath, payload], {
      unit: `lsp-witness-${process.pid}-${Date.now()}`, slice: 'papercusp-sidecar.slice',
      env: { PATH: process.env.PATH, NODE_OPTIONS: '', WITNESS_EXACT: 'scoped' },
    });
    try {
      writeFileSync(f.entry, `import {spawn} from 'node:child_process';spawn(${JSON.stringify(launch.argv[0])},${JSON.stringify(launch.argv.slice(1))},{stdio:'inherit'});setInterval(()=>{},1000);`);
      await withLiveRuntime(f, pids => {
        const { witness, reader } = liveWitness(f, [f.entry, SYSTEMD_ENV_RUNNER_PATH, launch.transport!.sourcePath, payload]);
        for (const pid of pids) {
          const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
          expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
        }
        expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'child-launch', route: 'systemd-scope', entry: SYSTEMD_ENV_RUNNER_PATH }));
      });
    } finally { launch.transport?.release(); }
  }, 20_000);
});

describe('fail-closed runtime qualification', () => {
  function proof() {
    const f = fixture();
    const base = { schemaVersion: 'lsp-replay-runtime-receipt-v1', pid: 42, identity: 'epoch', runId: 'run' };
    const rows: Record<string, unknown>[] = [ { ...base, kind: 'bootstrap', entry: f.entry, nodeOptions: '', evalSha256: f.launch.evalSha256 },
      { ...base, kind: 'ready' }, { ...base, kind: 'esm-load-return', path: f.entry, sha256: replayHash(readFileSync(f.entry)) } ];
    const library = '/lib/native.so';
    const witness: ReplayRuntimeWitness = { directory: f.root, runId: 'run', bootstraps: { [f.entry]: f.launch.evalSha256 },
      files: { [f.entry]: replayHash(readFileSync(f.entry)), [library]: replayHash('mapped inode') } };
    const reader = { identity: () => 'epoch', link: () => '', bytes: () => Buffer.from('mapped inode'),
      text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : rows.map(row => JSON.stringify(row)).join('\n') + '\n' };
    return { f, rows, witness, reader };
  }
  it('qualifies matching executed bytes and actual mapped inode bytes', () => {
    const p = proof();
    expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, p.reader).unknown).toEqual([]);
  });
  it('opens canonical map_files ranges without padding or 64-bit address rounding', () => {
    for (const [printed, canonical] of [
      ['00400000-00420000', '400000-420000'],
      ['00fffffffffffff1-00fffffffffffff3', 'fffffffffffff1-fffffffffffff3'],
    ]) {
      const p = proof();
      const reads: string[] = [];
      const reader = { ...p.reader,
        text: (path: string) => path.endsWith('/maps') ? `${printed} r-xp 0 00:01 9 /lib/native.so\n` : p.reader.text(path),
        bytes: (path: string) => {
          reads.push(path);
          if (path !== `/proc/42/map_files/${canonical}`) throw new Error('mapping does not exist');
          return Buffer.from('mapped inode');
        },
      };
      expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader).unknown).toEqual([]);
      expect(reads).toEqual([`/proc/42/map_files/${canonical}`]);
    }
  });
  it('refuses stale process receipts, unfrozen vendor bytes and a substituted recorder', () => {
    const p = proof(); p.rows[2].sha256 = replayHash('changed vendor');
    const result = replayLoadedRuntime(42, 'another epoch', [process.execPath, '--eval', 'different recorder'], p.witness, p.reader);
    expect(result.unknown).toContain('runtime-receipt-identity-mismatch');
    expect(result.unknown).toContain('unwitnessed-runtime-bootstrap');
    expect(result.unknown).toContain(`unfrozen-loaded-bytes:${p.f.entry}`);
    expect(result.unknown).toContain('process-replaced-during-runtime-witness');
  });
  it('keeps missing native access and truncated receipts unknown without disk fallbacks', () => {
    const p = proof();
    const reader = { ...p.reader, bytes: () => { throw new Error('permission denied'); },
      text: (path: string) => path.endsWith('/maps') ? p.reader.text(path) : p.reader.text(path).trim() };
    const result = replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader);
    expect(result.unknown).toContain('incomplete-runtime-receipt');
    expect(result.unknown.some(reason => reason.startsWith('unreadable-native-mappings'))).toBe(true);
  });
  it('refuses an empty native mapping census', () => {
    const p = proof();
    const reader = { ...p.reader, text: (path: string) => path.endsWith('/maps') ? '' : p.reader.text(path) };
    expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader).unknown)
      .toContain('empty-native-mapping-census');
  });
});
