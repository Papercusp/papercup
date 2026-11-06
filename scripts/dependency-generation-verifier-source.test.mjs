import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { buildInputs, buildWorkspace, captureClosure, verifyClosure } from '../apps/operator/bin/release/dependency-generation-verifier.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verifier-source-census-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  write(root, '.gitignore', 'node_modules/\ndist/\napps/operator/dist-verify/\n');
  write(root, 'package.json', '{"name":"census-fixture","private":true}');
  return root;
}
function generatedPackage(root, path) {
  write(root, path + '/package.json', JSON.stringify({ name: 'generated-bin', bin: 'dist/cli.cjs' }));
  write(root, path + '/src/cli.cjs', 'console.log("source-census");\n');
}
function ignoredCandidate(root) {
  // A retained native candidate is an output, even though it contains a full
  // source checkout and real package manifests with generated bin entries.
  const path = 'apps/operator/dist-verify/retained-candidate/packages/omp-plugin';
  generatedPackage(root, path);
  return path;
}

test('bounded source census preserves bytes, modes, links and membership through a producing build', () => {
  const root = fixture();
  generatedPackage(root, 'packages/cli');
  for (let i = 0; i < 160; i++) write(root, `src/file-${i}.js`, `export default ${i};\n`);
  write(root, 'src/odd\nname with spaces.js', 'export default "odd";\n');
  chmodSync(join(root, 'src/file-0.js'), 0o755);
  symlinkSync('file-0.js', join(root, 'src/alias.js'));
  const inputs = buildInputs(root);
  assert.deepEqual(inputs.map(row => row.path), [...inputs.map(row => row.path)].sort());
  assert.ok(inputs.length > 160);
  for (const row of inputs) {
    if (row.path === 'src/alias.js') assert.deepEqual(row, { path: row.path, link: 'file-0.js' });
    else {
      assert.equal(row.sha256, createHash('sha256').update(readFileSync(join(root, row.path))).digest('hex'));
      assert.equal(row.executable, row.path === 'src/file-0.js');
    }
  }
  buildWorkspace(root, 'packages/cli', [process.execPath, '-e',
    'const fs=require("node:fs");fs.mkdirSync("dist");fs.copyFileSync("src/cli.cjs","dist/cli.cjs");']);
  assert.equal(captureClosure(root).complete, true);
  // Same-length bytes and a new input must each invalidate producing custody.
  write(root, 'src/file-1.js', 'export default 9;\n');
  assert.equal(captureClosure(root).complete, false);
  write(root, 'src/file-1.js', 'export default 1;\n');
  write(root, 'src/new.js', 'export default "new";\n');
  assert.equal(captureClosure(root).complete, false);
  rmSync(join(root, 'src/new.js'));
  assert.throws(() => buildWorkspace(root, 'packages/cli', [process.execPath, '-e',
    'const fs=require("node:fs");fs.mkdirSync("dist");fs.copyFileSync("src/cli.cjs","dist/cli.cjs");fs.writeFileSync("../../src/file-1.js","changed");']),
  /source-changed-during-build/);
  assert.equal(existsSync(join(root, 'packages/cli/dist/.papercusp-workspace-build.json')), false);
  rmSync(join(root, 'src/alias.js'));
  symlinkSync('../../outside', join(root, 'src/alias.js'));
  assert.throws(() => buildInputs(root));
});

test('producing build exposes the failing phase without publishing a receipt', () => {
  const root = fixture();
  generatedPackage(root, 'packages/cli');
  const helper = new URL('../apps/operator/bin/release/dependency-generation-verifier.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [fileURLToPath(helper), 'build', root, 'packages/cli', '--',
    process.execPath, '-e', 'process.exit(17)'], { encoding: 'utf8' });
  assert.equal(run.status, 74);
  assert.match(run.stderr, /build-failed:packages\/cli:status=17/);
  const phases = run.stderr.split('\n').filter(line => line.startsWith('VERIFIER_WORKSPACE_BUILD_PHASE '))
    .map(line => JSON.parse(line.slice('VERIFIER_WORKSPACE_BUILD_PHASE '.length)));
  assert.deepEqual(phases.map(row => [row.phase, row.state]), [
    ['input-census-before', 'started'], ['input-census-before', 'complete'],
    ['command', 'started'], ['command', 'failed'],
  ]);
  assert.ok(phases.every(row => row.packagePath === 'packages/cli' && row.elapsedMs >= 0));
  assert.equal(existsSync(join(root, 'packages/cli/dist/.papercusp-workspace-build.json')), false);
});

test('closure capture ignores retained candidates without weakening real workspace custody', () => {
  const root = fixture();
  generatedPackage(root, 'packages/cli');
  buildWorkspace(root, 'packages/cli', [process.execPath, '-e',
    'const fs=require("node:fs");fs.mkdirSync("dist");fs.copyFileSync("src/cli.cjs","dist/cli.cjs");']);
  ignoredCandidate(root);

  const closure = captureClosure(root);
  assert.equal(closure.complete, true, closure.reason);
  assert.deepEqual(closure.workspaces.map(entry => entry.output), ['packages/cli/dist']);
  assert.equal(readFileSync(join(root, 'packages/cli/dist/cli.cjs'), 'utf8'), 'console.log("source-census");\n');

  rmSync(join(root, 'packages/cli/dist/.papercusp-workspace-build.json'));
  const missing = captureClosure(root);
  assert.equal(missing.complete, false);
  assert.match(missing.reason, /packages\/cli\/dist\/\.papercusp-workspace-build\.json/);
});

test('a new untracked source package still requires a generated-output receipt', () => {
  const root = fixture();
  ignoredCandidate(root);
  generatedPackage(root, 'packages/new-cli');
  const closure = captureClosure(root);
  assert.equal(closure.complete, false);
  assert.match(closure.reason, /packages\/new-cli\/dist\/\.papercusp-workspace-build\.json/);
});

test('selected-source verification ignores candidate output but rejects a new source bin', () => {
  const root = fixture();
  const generation = mkdtempSync(join(tmpdir(), 'verifier-census-generation-'));
  roots.push(generation);
  mkdirSync(join(generation, 'tree'));
  const closure = captureClosure(root);
  assert.equal(closure.complete, true, closure.reason);
  write(generation, '.verifier-closure.json', JSON.stringify(closure));
  ignoredCandidate(root);

  assert.doesNotThrow(() => verifyClosure(generation, root));
  generatedPackage(root, 'packages/new-cli');
  assert.throws(() => verifyClosure(generation, root), /workspace-requirements-mismatch/);
});

test('incomplete generation reports producer evidence before copying workspace output', () => {
  const root = fixture();
  generatedPackage(root, 'packages/cli');
  const closure = captureClosure(root);
  assert.equal(closure.complete, false);
  const generation = mkdtempSync(join(tmpdir(), 'verifier-incomplete-generation-'));
  roots.push(generation);
  write(generation, '.verifier-closure.json', JSON.stringify(closure));

  assert.throws(() => verifyClosure(generation, root, true), error => {
    assert.match(error.message, /^verifier-generation:incomplete-closure:/);
    assert.ok(error.message.includes(generation));
    assert.ok(error.message.includes(closure.reason));
    return true;
  });
  // Refusal must precede any materialization, even if no generation tree exists.
  assert.equal(readFileSync(join(root, 'packages/cli/src/cli.cjs'), 'utf8'),
    'console.log("source-census");\n');
  assert.throws(() => readFileSync(join(root, 'packages/cli/dist/cli.cjs')), { code: 'ENOENT' });
});
