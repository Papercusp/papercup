import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayHash, replayLoadedRuntime, replayRuntimeLaunch, type ReplayRuntimeWitness } from './lsp-fleet-replay-runtime';
import { readProcessIdentity } from '../process-identity';
import { fileURLToPath } from 'node:url';
import { buildTaskScopeArgvWithTransport, SYSTEMD_ENV_RUNNER_PATH, SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';

const scopeProbeArgv = ['--user', '--scope', '--quiet', ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS, '--', 'true'];

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
  it('qualifies real default-loader deferred CommonJS only after its actual compile', async () => {
    const f = fixture('cjs', 'require("./worker.js");console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);');
    const worker = join(f.root, 'worker.js'); writeFileSync(worker, 'module.exports = 42;');
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const rows = receipts(f.root);
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-load-pending', path: worker }));
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-compile', path: worker, sha256: witness.files[worker] }));
      expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
    });
  });
  it('records and validates exact kernel metadata reads without freezing volatile proc files', async () => {
    const f = fixture('mjs', `import {readFileSync,readFile} from 'node:fs';import {readFile as readPromise} from 'node:fs/promises';
      readFileSync('/proc/sys/kernel/random/boot_id','utf8');
      await readPromise('/proc/self/cgroup','utf8');
      await new Promise((resolve,reject)=>readFile('/proc/'+process.pid+'/stat','utf8',error=>error?reject(error):resolve()));
      readFileSync('/proc/version','utf8');console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = (r = reader) => replayLoadedRuntime(pid, reader.identity(pid), command, witness, r).unknown;
      expect(receipts(f.root).filter(row => row.kind === 'kernel-metadata')).toHaveLength(3);
      expect(qualify()).toEqual(['unfrozen-loaded-bytes:/proc/version']);
      const changed = { ...reader, text: (path: string) => path.endsWith('/cgroup') ? '0::/different\n' : reader.text(path) };
      expect(qualify(changed).some(reason => reason.startsWith('unqualified-kernel-metadata:/proc/self/cgroup:'))).toBe(true);
      const receiptPath = join(f.root, `${pid}.jsonl`);
      const rows = receipts(f.root);
      const stat = rows.find(row => row.kind === 'kernel-metadata' && row.path.endsWith('/stat'));
      stat.subjectIdentity = 'different-process-epoch';
      writeFileSync(receiptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith(`unqualified-kernel-metadata:/proc/${pid}/stat:`))).toBe(true);
    });
  });
  it('qualifies main-task children reads and refuses changed bytes, process epochs and task paths', async () => {
    const f = fixture('mjs', `import {readFileSync} from 'node:fs';import {readFile} from 'node:fs/promises';
      readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children');
      await readFile('/proc/self/task/'+process.pid+'/children','utf8');
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = (r = reader) => replayLoadedRuntime(pid, reader.identity(pid), command, witness, r).unknown;
      const rows = receipts(f.root);
      const metadata = rows.filter(row => row.kind === 'kernel-metadata');
      expect(metadata).toHaveLength(2);
      for (const row of metadata) {
        expect(row).toMatchObject({ subjectPid: pid, subjectIdentity: reader.identity(pid),
          text: reader.text(`/proc/${pid}/task/${pid}/children`) });
        expect(row.sha256).toBe(replayHash(row.text));
      }
      expect(qualify()).toEqual([]);
      const changed = { ...reader, text: (path: string) => path.endsWith('/children') ? `${pid} ` : reader.text(path) };
      expect(qualify(changed).some(reason => reason.includes('kernel control input changed'))).toBe(true);
      const receiptPath = join(f.root, `${pid}.jsonl`);
      const rewrite = (mutate: (row: Record<string, unknown>) => void) => {
        const copy = JSON.parse(JSON.stringify(rows));
        mutate(copy.find((row: Record<string, unknown>) => row.kind === 'kernel-metadata'));
        writeFileSync(receiptPath, copy.map((row: Record<string, unknown>) => JSON.stringify(row)).join('\n') + '\n');
      };
      for (const mutate of [
        (row: Record<string, unknown>) => { row.sha256 = replayHash('altered bytes'); },
        (row: Record<string, unknown>) => { row.subjectIdentity = 'different-process-epoch'; },
        (row: Record<string, unknown>) => { row.path = `/proc/${pid}/task/${pid + 1}/children`; },
        (row: Record<string, unknown>) => { row.path = `/proc/${pid}/task/${pid}/status`; },
      ]) {
        rewrite(mutate);
        expect(qualify().some(reason => reason.startsWith('unqualified-kernel-metadata:'))).toBe(true);
      }
      rewrite(row => { row.text = `${pid} `; row.sha256 = replayHash(String(row.text)); });
      expect(qualify().some(reason => reason.includes('kernel control input changed'))).toBe(true);
    });
  });
  it('refuses altered metadata bytes and stat identity even when a receipt hash is recomputed', async () => {
    const f = fixture('mjs', `import {readFileSync} from 'node:fs';readFileSync('/proc/'+process.pid+'/stat','utf8');
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pid, reader.identity(pid), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rows = receipts(f.root);
      const stat = rows.find(row => row.kind === 'kernel-metadata');
      const path = join(f.root, `${pid}.jsonl`);
      stat.sha256 = replayHash('altered bytes');
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith('unqualified-kernel-metadata:'))).toBe(true);
      const fields = stat.text.slice(stat.text.lastIndexOf(')') + 2).split(' '); fields[19] = '0';
      stat.text = stat.text.slice(0, stat.text.lastIndexOf(')') + 2) + fields.join(' '); stat.sha256 = replayHash(stat.text);
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('stat epoch or parent mismatch'))).toBe(true);
    });
  });
  it('qualifies a declared symlink launcher through its recorded canonical loaded entry', async () => {
    const f = fixture();
    const entry = join(f.root, 'launcher.mjs'); symlinkSync('entry.mjs', entry);
    writeFileSync(f.entry, 'console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);');
    const linked = { ...f, entry, launch: replayRuntimeLaunch(entry, f.root, 'witness-test') };
    await withLiveRuntime(linked, pids => {
      const { witness, reader } = liveWitness(linked, [entry, f.entry]);
      expect(receipts(f.root)[0]).toMatchObject({ entry, entryCanonical: f.entry });
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
      const incomplete = { ...witness, files: { [entry]: witness.files[entry], '/test-native-mapping': witness.files['/test-native-mapping'] } };
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, incomplete, reader).unknown).toContain('unfrozen-runtime-entry-alias');
    });
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
  it.each(['spawn', 'fork', 'execFile'] as const)('records anchored %s child exit codes and signals without requiring a live child', async route => {
    for (const termination of ['code', 'signal'] as const) {
      const f = fixture();
      const worker = join(f.root, 'terminal-worker.cjs');
      writeFileSync(worker, termination === 'code' ? 'process.exit(7);' : 'console.log("ready");setInterval(()=>{},1000);');
      const args = route === 'fork' ? JSON.stringify(worker) : `process.execPath,[${JSON.stringify(worker)}]`;
      const options = route === 'fork' ? '{silent:true}' : '{stdio:["ignore","pipe","pipe"]}';
      writeFileSync(f.entry, `import {${route}} from 'node:child_process';
        const c=${route}(${args},${options});
        ${termination === 'signal' ? 'c.stdout.once("data",()=>c.kill("SIGTERM"));' : ''}
        c.once('exit',()=>{console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
      await withLiveRuntime(f, pids => {
        const rows = receipts(f.root).filter(row => row.pid === pids[0]);
        const started = rows.find(row => row.kind === 'child-started');
        const terminal = rows.filter(row => row.kind === 'child-exit');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ launchId: started.launchId, childPid: started.childPid,
          childIdentity: started.childIdentity, code: termination === 'code' ? 7 : null,
          signal: termination === 'signal' ? 'SIGTERM' : null });
        expect(terminal[0].atMs).toBeGreaterThan(0);
        const { witness, reader } = liveWitness(f, [f.entry, worker]);
        const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
        const qualify = () => replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown;
        expect(qualify()).toEqual([]);
        const rootPath = join(f.root, `${pids[0]}.jsonl`);
        const original = readFileSync(rootPath, 'utf8');
        for (const [field, value] of [['launchId', 'another-launch'], ['childIdentity', 'reused-epoch'],
          ['atMs', null], ['code', -1], ['signal', 'invalid-signal']] as const) {
          const saved = terminal[0][field];
          terminal[0][field] = value;
          writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
          expect(qualify()).toContain('unqualified-child-terminal');
          terminal[0][field] = saved;
        }
        writeFileSync(rootPath, [...rows, terminal[0]].map(row => JSON.stringify(row)).join('\n') + '\n');
        expect(qualify()).toContain('unqualified-child-terminal');
        writeFileSync(rootPath, original);
        expect(qualify()).toEqual([]);
      });
    }
  }, 20_000);
  it.each((['spawn', 'fork', 'execFile'] as const).flatMap(route =>
    [false, true].map(decoded => ({ route, decoded }))))('preserves bounded $route stderr diagnostics without stealing consumer bytes (decoded=$decoded)', async ({ route, decoded }) => {
    const f = fixture();
    const worker = join(f.root, 'stderr-worker.cjs');
    const bytes = Buffer.concat([Buffer.alloc(12_000, 120), Buffer.from('\nFATAL ERROR: fixture diagnostic 👋\n')]);
    writeFileSync(worker, `const bytes=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64');
      process.stderr.write(bytes.subarray(0,bytes.length-3),()=>
        process.stderr.write(bytes.subarray(bytes.length-3),()=>process.exit(7)));`);
    const args = route === 'fork' ? JSON.stringify(worker) : `process.execPath,[${JSON.stringify(worker)}]`;
    const options = route === 'fork' ? '{silent:true}' : '{stdio:["ignore","pipe","pipe"]}';
    writeFileSync(f.entry, `import {${route}} from 'node:child_process';import {createHash} from 'node:crypto';
      const c=${route}(${args},${options});const chunks=[];
      ${route !== 'execFile' ? 'if(c.stderr.readableFlowing!==null)throw Error("recorder changed stderr flow");' : ''}
      ${decoded ? "c.stderr.setEncoding('utf8');" : ''}
      c.stderr.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
      c.once('close',()=>{if(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')!==${JSON.stringify(replayHash(bytes))})
        throw Error('diagnostic recorder changed consumer stderr');
        console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const rows = receipts(f.root).filter(row => row.pid === pids[0]);
      const started = rows.find(row => row.kind === 'child-started');
      const diagnostics = rows.filter(row => row.kind === 'child-stderr');
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics[0];
      const tail = bytes.subarray(-8192);
      expect(diagnostic).toMatchObject({ launchId: started.launchId, childPid: started.childPid,
        childIdentity: started.childIdentity, piped: true, totalBytes: bytes.length,
        tailBase64: tail.toString('base64'), sha256: replayHash(tail) });
      expect(diagnostic.atMs).toBeGreaterThanOrEqual(rows.find(row => row.kind === 'child-exit').atMs);
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rootPath = join(f.root, `${pids[0]}.jsonl`);
      const rewrite = () => writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      for (const [field, value] of [['launchId', 'another-launch'], ['childPid', -1],
        ['childIdentity', 'reused-epoch'], ['atMs', null], ['atMs', 1], ['piped', false], ['piped', 'yes'],
        ['totalBytes', 1], ['totalBytes', -1], ['totalBytes', 1.5],
        ['tailBase64', '!not-base64!'], ['tailBase64', tail.toString('base64') + '\n'],
        ['sha256', replayHash('changed')]] as const) {
        const saved = diagnostic[field]; diagnostic[field] = value; rewrite();
        expect(qualify()).toContain('unqualified-child-stderr');
        diagnostic[field] = saved;
      }
      writeFileSync(rootPath, [...rows, diagnostic].map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify()).toContain('unqualified-child-stderr');
      rewrite();
      expect(qualify()).toEqual([]);
      writeFileSync(rootPath, rows.filter(row => row.kind !== 'child-exit').map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify()).toContain('unqualified-child-stderr');
      rewrite();
    });
  }, 20_000);
  it.each(['pipe', 'ignore'] as const)('qualifies empty %s stderr after child close', async stderr => {
    const f = fixture();
    const worker = join(f.root, 'empty-stderr-worker.cjs');
    writeFileSync(worker, 'process.exit(0);');
    writeFileSync(f.entry, `import {spawn} from 'node:child_process';
      const c=spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:['ignore','ignore',${JSON.stringify(stderr)}]});
      c.once('close',()=>{console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const rows = receipts(f.root).filter(row => row.pid === pids[0]);
      const diagnostics = rows.filter(row => row.kind === 'child-stderr');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ piped: stderr === 'pipe', totalBytes: 0,
        tailBase64: '', sha256: replayHash(Buffer.alloc(0)) });
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
    });
  }, 20_000);
  it('records child launch errors while preserving handled and unhandled error behavior', () => {
    for (const handled of [true, false]) {
      const f = fixture();
      const worker = join(f.root, 'worker.cjs'); writeFileSync(worker, 'process.exit(0);');
      writeFileSync(f.entry, `import {spawn} from 'node:child_process';
        const c=spawn(process.execPath,[${JSON.stringify(worker)}],{cwd:${JSON.stringify(join(f.root, 'missing-directory'))}});
        ${handled ? 'c.once("error",()=>console.log("handled"));' : ''}`);
      const execute = () => execFileSync(process.execPath, f.launch.args,
        { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', stdio: 'pipe' });
      if (handled) expect(execute()).toContain('handled');
      else expect(execute).toThrow();
      const rows = receipts(f.root);
      const started = rows.find(row => row.kind === 'child-started');
      const terminal = rows.filter(row => row.kind === 'child-error');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ launchId: started.launchId, childPid: null, childIdentity: null });
      expect(terminal[0].error).toContain('ENOENT');
      expect(terminal[0].atMs).toBeGreaterThan(0);
    }
  });
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
  it('witnesses the exact managed availability probe as terminal control evidence and rejects incomplete or altered proof', async () => {
    const f = fixture('mjs', `import {spawn} from 'node:child_process';
      const c=spawn('systemd-run',${JSON.stringify(scopeProbeArgv)},{stdio:['ignore','ignore','pipe']});
      let errors='';c.stderr.on('data',chunk=>errors+=chunk);c.on('exit',code=>{if(code!==0)throw Error(errors);
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry, process.execPath]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pid, reader.identity(pid), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rows = receipts(f.root).filter(row => row.pid === pid);
      const launch = rows.find(row => row.kind === 'child-launch');
      expect(launch).toMatchObject({ controlPurpose: 'systemd-scope-availability', originalArgv: scopeProbeArgv });
      expect(receipts(f.root).filter(row => row.pid !== pid).map(row => row.kind)).toEqual(['bootstrap','control-complete']);
      const rootPath = join(f.root, `${pid}.jsonl`);
      const original = readFileSync(rootPath, 'utf8');
      for (const field of ['originalArgv', 'argv']) {
        const saved = launch[field];
        launch[field] = saved.filter((arg: string) => arg !== '--property=CollectMode=inactive-or-failed');
        writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        expect(qualify().some(reason => reason.includes('unsupported control launch'))).toBe(true);
        launch[field] = saved;
        writeFileSync(rootPath, original);
      }
      const unfrozen = { ...witness, files: { ...witness.files } }; delete unfrozen.files[process.execPath];
      expect(replayLoadedRuntime(pid, reader.identity(pid), command, unfrozen, reader).unknown
        .some(reason => reason.startsWith('unqualified-control-probe:'))).toBe(true);
      writeFileSync(rootPath, rows.filter(row => row.kind !== 'control-exit').map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith('unqualified-control-probe:'))).toBe(true);
      writeFileSync(rootPath, original);
      const control = receipts(f.root).find(row => row.kind === 'control-complete');
      const controlPath = join(f.root, `${control.pid}.jsonl`);
      const controlRows = receipts(f.root).filter(row => row.pid === control.pid);
      const originalControl = readFileSync(controlPath, 'utf8');
      controlRows[1].ancestry[0].identity = 'reused-process-epoch';
      writeFileSync(controlPath, controlRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('unanchored control ancestry'))).toBe(true);
      writeFileSync(controlPath, originalControl);
      controlRows[1].ancestry[0].identity = controlRows[0].identity;
      controlRows[1].executableSha256 = replayHash('unfrozen executable');
      writeFileSync(controlPath, controlRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('unwitnessed control completion'))).toBe(true);
    });
  }, 20_000);
  it.each([
    [...scopeProbeArgv, 'extra'],
    scopeProbeArgv.map(arg => arg === '--property=CollectMode=inactive-or-failed' ? '--property=CollectMode=inactive' : arg),
    scopeProbeArgv.filter(arg => arg !== '--property=CollectMode=inactive-or-failed'),
  ])('keeps altered native availability commands unqualified (%j)', (...argv) => {
    const f = fixture('mjs', `import {spawn} from 'node:child_process';
      const c=spawn('systemd-run',${JSON.stringify(argv)},{stdio:'ignore'});
      await new Promise(resolve=>c.on('exit',resolve));`);
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'unsupported-child-launch:true' }));
    expect(receipts(f.root).some(row => row.controlPurpose)).toBe(false);
  });
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
  it('refuses deferred CommonJS without the matching compile bytes', () => {
    const p = proof();
    p.rows.push({ ...p.rows[2], kind: 'commonjs-load-pending' });
    const qualify = () => replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, p.reader);
    expect(qualify().unknown).toContain(`uncompleted-commonjs-load:${p.f.entry}`);
    p.rows.push({ ...p.rows[2], kind: 'commonjs-compile', sha256: replayHash('different source') });
    expect(qualify().unknown).toContain(`uncompleted-commonjs-load:${p.f.entry}`);
    p.rows[p.rows.length - 1].sha256 = p.rows[2].sha256;
    expect(qualify().unknown).toEqual([]);
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
