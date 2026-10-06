import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayHash, replayLoadedRuntime, replayRuntimeLaunch, type ReplayRuntimeWitness } from './lsp-fleet-replay-runtime';

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
});
