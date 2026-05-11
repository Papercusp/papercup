// Test loadPluginFromDir's runtime branching (G3). Builds tiny plugin
// dirs in /tmp and asserts the loader returns the right shape.
import { loadPluginFromDir } from '../src/index.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, detail ?? ''); }
};

const root = mkdtempSync(join(tmpdir(), 'plugin-loader-test-'));

// ------ Test 1: JS plugin (no runtime field — defaults to JS) ------
console.log('# JS plugin defaults to runtime=js');
const jsDir = join(root, 'js-plugin');
mkdirSync(jsDir);
writeFileSync(join(jsDir, 'papercusp.json'), JSON.stringify({
  name: 'js-plugin',
  version: '1.0.0',
  capabilities: [],
}));
writeFileSync(join(jsDir, 'index.js'), 'module.exports = { name: "js-plugin", version: "1.0.0", capabilities: [] };');
let r = await loadPluginFromDir(jsDir, 'project');
ok(!('error' in r) && !('skipped' in r), 'no error', JSON.stringify(r));
ok(r.runtime?.kind === 'js', 'runtime defaulted to js', JSON.stringify(r.runtime));

// ------ Test 2: WASM plugin with valid wasm path ------
console.log('# WASM plugin with valid path → wasm shim');
const wasmDir = join(root, 'wasm-plugin');
mkdirSync(wasmDir);
writeFileSync(join(wasmDir, 'plugin.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
writeFileSync(join(wasmDir, 'papercusp.json'), JSON.stringify({
  name: 'wasm-plugin',
  version: '1.0.0',
  runtime: { kind: 'wasm', wasmPath: 'plugin.wasm' },
}));
r = await loadPluginFromDir(wasmDir, 'project');
ok(!('error' in r) && !('skipped' in r), 'no error', JSON.stringify(r));
ok(r.runtime?.kind === 'wasm', 'runtime kind=wasm');
ok(r.runtime?.wasmPath?.endsWith('plugin.wasm'), 'wasm path resolved to absolute');

// ------ Test 3: WASM plugin with missing wasm artifact ------
console.log('# WASM plugin with missing wasm → error');
const wasmMissingDir = join(root, 'wasm-missing');
mkdirSync(wasmMissingDir);
writeFileSync(join(wasmMissingDir, 'papercusp.json'), JSON.stringify({
  name: 'wasm-missing',
  version: '1.0.0',
  runtime: { kind: 'wasm', wasmPath: 'gone.wasm' },
}));
r = await loadPluginFromDir(wasmMissingDir, 'project');
ok('error' in r && r.error.includes('not found'), 'rejects missing artifact', JSON.stringify(r));

// ------ Test 4: WASM plugin without wasmPath ------
console.log('# WASM plugin missing wasmPath → error');
const wasmNoPathDir = join(root, 'wasm-nopath');
mkdirSync(wasmNoPathDir);
writeFileSync(join(wasmNoPathDir, 'papercusp.json'), JSON.stringify({
  name: 'wasm-nopath',
  version: '1.0.0',
  runtime: { kind: 'wasm' },
}));
r = await loadPluginFromDir(wasmNoPathDir, 'project');
ok('error' in r && r.error.includes('wasmPath missing'), 'rejects no wasmPath', JSON.stringify(r));

// ------ Test 5: Daemon plugin with cmd ------
console.log('# Daemon plugin → daemon shim');
const daemonDir = join(root, 'daemon-plugin');
mkdirSync(daemonDir);
writeFileSync(join(daemonDir, 'papercusp.json'), JSON.stringify({
  name: 'daemon-plugin',
  version: '1.0.0',
  runtime: { kind: 'daemon', daemonCommand: ['/usr/bin/echo', 'hello'] },
}));
r = await loadPluginFromDir(daemonDir, 'project');
ok(!('error' in r) && !('skipped' in r), 'no error', JSON.stringify(r));
ok(r.runtime?.kind === 'daemon', 'runtime kind=daemon');
ok(Array.isArray(r.runtime?.daemonCommand) && r.runtime.daemonCommand[0] === '/usr/bin/echo', 'daemon cmd preserved');

// ------ Test 6: Daemon plugin without cmd ------
console.log('# Daemon plugin without cmd → error');
const daemonNoCmdDir = join(root, 'daemon-nocmd');
mkdirSync(daemonNoCmdDir);
writeFileSync(join(daemonNoCmdDir, 'papercusp.json'), JSON.stringify({
  name: 'daemon-nocmd',
  version: '1.0.0',
  runtime: { kind: 'daemon' },
}));
r = await loadPluginFromDir(daemonNoCmdDir, 'project');
ok('error' in r && (r.error.includes('daemonCommand') || r.error.includes('empty')), 'rejects empty cmd', JSON.stringify(r));

// Cleanup
rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
