// Report-only verification; never launches the Storewolf application.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const out = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.STOREWOLF_AUDIT_ROOT || path.join(os.homedir(), 'storewolf-central-server');
const lib = process.env.STOREWOLF_LIBS_AUDIT_ROOT || path.join(os.homedir(), 'Storewolf-Libs');
const T = path.join(root, 'Services/Transformer');
const files = [
  ...['Transformer.js', 'SKUTransformerMaster.js', 'SKUTransformerChild.js',
    'SKUTransformer.js', 'SpecObjComparator.js', 'ComparatorConfigs/Computer.js',
    'Rankifier.js', 'RankifierFunctions.js', 'WeightGetterByCategoryGroup.js',
    'FBEUtil.js', 'package.json'].map(f => path.join(T, f)),
  ...['Util/ProcessRouterParent.js', 'lib/StoreWolfInterface.js',
    'Services/OrderProcessor/OrderProcessor.js', 'Services/Synchronizer/Synchronizer.js'].map(f => path.join(root, f)),
  ...['ProcessRouterParent.js', 'ProcessRouterChild.js', 'SharedMap.js'].map(f => path.join(lib, f)),
];
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const before = Object.fromEntries(files.map(f => [f, hash(f)]));
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
  path.join(out, 'audit-probes.test.cjs')], { encoding: 'utf8', timeout: 30000,
  env: { ...process.env, FORCE_COLOR: '0' } });
assert.equal(run.status, 0, run.stdout + run.stderr);
assert.match(run.stdout, /tests 10/);
assert.match(run.stdout, /pass 10/);
assert.match(run.stdout, /fail 0/);
const after = Object.fromEntries(files.map(f => [f, hash(f)]));
assert.deepEqual(after, before, 'subject source must not change during the checks');
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');
await mermaid.parse(fs.readFileSync(path.join(out, 'architecture.mmd'), 'utf8'));
const svg = fs.readFileSync(path.join(out, 'architecture.svg'), 'utf8');
const svgDoc = new dom.window.DOMParser().parseFromString(svg, 'image/svg+xml');
assert.equal(svgDoc.querySelector('parsererror'), null);
assert.equal(svgDoc.documentElement.getAttribute('width'), '1200');
assert.equal(svgDoc.documentElement.getAttribute('height'), '1070');
execFileSync('rsvg-convert', [path.join(out, 'architecture.svg'), '-o', path.join(out, 'architecture.png')]);
assert.ok(fs.statSync(path.join(out, 'architecture.png')).size > 10000);
const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
const roots = { T, A: root, L: lib };
let citationChecks = 0;
for (const match of readme.matchAll(/`([TAL])\/([^`]+)`/g)) {
  const [rel, range] = match[2].split(':');
  const file = path.join(roots[match[1]], rel);
  assert.ok(fs.existsSync(file), file);
  if (range) {
    const end = Number(range.split(/[–-]/).at(-1));
    assert.ok(end <= fs.readFileSync(file, 'utf8').split('\n').length, match[0]);
  }
  citationChecks++;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const evidence = {
  generatedAt: new Date().toISOString(), workItem: 'WI-10001436',
  kind: 'read-only source audit; not production verification',
  subjects: [root, T, lib].map(p => ({
    path: p, head: git(p, 'rev-parse', 'HEAD'),
    branch: git(p, 'branch', '--show-current'), status: git(p, 'status', '--short'),
  })),
  sourceFiles: files.map(f => ({ path: f, sha256: after[f] })),
  verification: {
    command: 'node --test audit-probes.test.cjs',
    exitCode: run.status, tests: 10, passed: 10, failed: 0,
    sourceStableDuringChecks: true, mermaidParse: 'pass (jsdom initialized before import)',
    svgXml: 'pass', svgRasterization: 'pass', width: 1200, height: 1070,
    citationPathsAndLineBounds: { checked: citationChecks, status: 'pass',
      limit: 'Path/line integrity only, not automated semantic validation' },
    safety: 'No application boot, service calls, real fork, LMDB, persisted DB writes or commerce IO. SQLite probe uses :memory:.',
    firstRun: '9/10; audit fixture expected undefined while failed-category count was actually zero; corrected fixture, not application.',
  },
  outputs: ['README.md', 'architecture.mmd', 'architecture.svg', 'architecture.png',
    'audit-probes.test.cjs', 'verify-report.mjs'].map(f => ({ path: f, sha256: hash(path.join(out, f)) })),
  notExercised: ['production startup/deployment', 'persisted model roundtrip',
    'full-model native Roaring/FBE behavior', 'live inventory freshness',
    'real IPC/LMDB concurrency', 'application RPC/auth', 'exhaustive category correctness', 'performance/load'],
};
fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence.verification, null, 2));
