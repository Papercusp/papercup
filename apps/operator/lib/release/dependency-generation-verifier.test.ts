import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInputs, checkSource, buildWorkspace as buildWorkspaceWithPhaseLogs, captureClosure, copyDependencyTree } from '../../bin/release/dependency-generation-verifier.mjs';
import { nativeVerifierEnv } from '../../../../scripts/lib/verify-tauri-native-env.mjs';
import { bindFrozenDependencyGeneration } from '../../../../packages/operator-core/lib/dependency-generation-proof';
import { prepareVerifierSource, runVerifierCommand, selectVerifierDependencySnapshot } from '../../../../scripts/source-preview.mjs';

// Imported builds intentionally report progress on stderr. Capture only this
// operation and validate its diagnostics, leaving unexpected console errors fatal.
function buildWorkspace(...args: Parameters<typeof buildWorkspaceWithPhaseLogs>) {
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return buildWorkspaceWithPhaseLogs(...args);
  } finally {
    const calls = diagnostics.mock.calls.slice();
    diagnostics.mockRestore();
    const prefix = 'VERIFIER_WORKSPACE_BUILD_PHASE ';
    const phases = calls.map(([message, ...extra]) => {
      expect(extra).toEqual([]);
      expect(message).toEqual(expect.stringMatching(/^VERIFIER_WORKSPACE_BUILD_PHASE /));
      const phase = JSON.parse(message.slice(prefix.length));
      expect(phase.packagePath).toBe(args[1]);
      expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
      return phase;
    });
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.length % 2).toBe(0);
    const order = ['input-census-before', 'command', 'input-census-after', 'output-census'];
    for (let index = 0; index < phases.length; index += 2) {
      const [start, end] = phases.slice(index, index + 2);
      expect(start).toMatchObject({ phase: order[index / 2], state: 'started' });
      expect(end.phase).toBe(start.phase);
      expect(['complete', 'failed']).toContain(end.state);
      expect(end.elapsedMs).toBeGreaterThanOrEqual(start.elapsedMs);
      if (end.state === 'failed') expect(index + 2).toBe(phases.length);
    }
  }
}

const repo = resolve(__dirname, '../../../..');
const script = join(repo, 'apps/operator/bin/release/dependency-generation.sh');
const helper = join(repo, 'papercusp-desktop/bin/lib/pinned-deps.sh');
const roots: string[] = [];
function write(root: string, path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function installTsxRuntime(f: ReturnType<typeof fixture>) {
  const sourceLock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  const fixtureLockPath = join(f.donor, 'package-lock.json');
  const fixtureLock = JSON.parse(readFileSync(fixtureLockPath, 'utf8'));
  const rootManifestPath = join(f.donor, 'package.json');
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
  const tsxRange = `^${sourceLock.packages['node_modules/tsx'].version}`;
  rootManifest.devDependencies = { ...(rootManifest.devDependencies ?? {}), tsx: tsxRange };
  fixtureLock.packages[''].devDependencies = { tsx: tsxRange };

  const pending = ['node_modules/tsx'];
  const packagePaths = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (packagePaths.has(path) || !sourceLock.packages[path]) continue;
    packagePaths.add(path);
    const entry = sourceLock.packages[path];
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const dependencyPath = `node_modules/${name}`;
      if (sourceLock.packages[dependencyPath]) pending.push(dependencyPath);
    }
  }

  for (const path of packagePaths) {
    fixtureLock.packages[path] = sourceLock.packages[path];
    const sourcePath = join(repo, path);
    if (!existsSync(sourcePath)) continue;
    const destination = join(f.donor, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(sourcePath, destination, { recursive: true });
  }
  writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);
  writeFileSync(fixtureLockPath, `${JSON.stringify(fixtureLock)}\n`);
}
function fixture(workspace = 'packages/cli') {
  const root = mkdtempSync(join(tmpdir(), 'native-generation-closure-')); roots.push(root);
  const donor = join(root, 'source'), dest = join(root, 'selected'), store = join(root, 'store');
  // Freeze the current implementation as committed fixture tooling. The
  // production source loader must remain enabled; otherwise a shell child can
  // silently substitute the previous committed helper for the code under test.
  const tooling = join(root, 'tooling');
  cpSync(dirname(script), join(tooling, 'apps/operator/bin/release'), { recursive: true });
  // The copied verifier imports this tracked-file helper; include its only
  // local runtime dependency so the committed tooling fixture is self-contained.
  const trackedFiles = 'libs/test-config/src/tracked-files.mjs';
  const gitIndexFaultCore = 'libs/test-config/src/git-index-fault-core.mjs';
  write(tooling, trackedFiles, readFileSync(join(repo, trackedFiles), 'utf8'));
  write(tooling, gitIndexFaultCore, readFileSync(join(repo, gitIndexFaultCore), 'utf8'));
  // The lock-tree auditor's source-only CLI guard is a runtime dependency,
  // including when the shell fixture runs before any npm installation.
  const cliEntry = 'packages/operator-core/lib/util/cli-entry.ts';
  write(tooling, cliEntry, readFileSync(join(repo, cliEntry), 'utf8'));
  const sourceVerifier = 'libs/test-config/src/verifier-source.ts';
  write(tooling, sourceVerifier, readFileSync(join(repo, sourceVerifier), 'utf8'));
  write(tooling, 'papercusp-desktop/bin/lib/pinned-deps.sh', readFileSync(helper, 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: tooling });
  execFileSync('git', ['add', '.'], { cwd: tooling });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'current generation tooling under test'], { cwd: tooling });
  const generationScript = join(tooling, 'apps/operator/bin/release/dependency-generation.sh');
  const snapshotHelper = join(tooling, 'papercusp-desktop/bin/lib/pinned-deps.sh');
  write(donor, '.gitignore', 'node_modules/\ndist/\n');
  write(donor, 'package.json', '{"name":"native-generation-fixture","private":true}');
  write(donor, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'native-generation-fixture' },
    'node_modules/pkg': { version: '1.0.0' },
  } }));
  write(donor, workspace + '/package.json', '{"name":"probe","bin":{"probe":"dist/cli.cjs"},"scripts":{"build":"node build.cjs"}}');
  write(donor, workspace + '/src/cli.cjs', 'console.log("frozen-workspace");\n');
  write(donor, workspace + '/build.cjs', `
const fs = require('node:fs'), path = require('node:path');
if (process.env.NATIVE_BUILD_PARENT) {
  const relative = path.relative(process.env.NATIVE_BUILD_PARENT, process.cwd());
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('native rebuild left the immutable store filesystem');
  fs.writeFileSync(process.env.NATIVE_BUILD_RECEIPT, process.cwd());
}
fs.mkdirSync('dist');fs.copyFileSync('src/cli.cjs','dist/cli.cjs');
`);
  // Any attempted canonical reader is an immediate test failure.
  write(donor, 'scripts/npm-install-safe.mjs', 'process.stderr.write("DONOR_READ_FORBIDDEN");process.exit(93);');
  write(donor, 'papercusp-desktop/package.json', '{"name":"desktop"}');
  write(donor, 'papercusp-desktop/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@tauri-apps/cli': { version: '2.0.0' },
  } }));
  cpSync(join(tooling, 'apps'), join(donor, 'apps'), { recursive: true });
  // runVerifierCommand freezes its invoked-source tree from the donor commit,
  // so runtime imports must be present in this source tree as well as tooling.
  cpSync(join(tooling, 'libs'), join(donor, 'libs'), { recursive: true });
  write(donor, sourceVerifier, readFileSync(join(tooling, sourceVerifier), 'utf8'));
  write(donor, cliEntry, readFileSync(join(tooling, cliEntry), 'utf8'));
  write(donor, 'papercusp-desktop/bin/lib/pinned-deps.sh', readFileSync(snapshotHelper, 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: donor });
  execFileSync('git', ['add', '.'], { cwd: donor });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'source for generated workspace output'], { cwd: donor });
  cpSync(donor, dest, { recursive: true });
  write(dest, '.verifier-source.json', JSON.stringify({ files: [{ path: workspace + '/package.json' }] }));
  write(donor, 'node_modules/pkg/package.json', '{"name":"pkg","version":"1.0.0"}');
  write(donor, 'node_modules/pkg/index.js', 'published dependency');
  mkdirSync(join(donor, 'node_modules/.bin'));
  symlinkSync('../../' + workspace + '/dist/cli.cjs', join(donor, 'node_modules/.bin/probe'));
  write(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/package.json', '{"name":"@tauri-apps/cli","version":"2.0.0"}');
  write(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js', '#!/usr/bin/env node\n');
  chmodSync(join(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'), 0o755);
  mkdirSync(join(donor, 'papercusp-desktop/node_modules/.bin'));
  symlinkSync('../@tauri-apps/cli/tauri.js', join(donor, 'papercusp-desktop/node_modules/.bin/tauri'));
  buildWorkspace(donor, workspace, [process.execPath, 'build.cjs']);
  const env = { ...process.env, PAPERCUSP_DEPENDENCY_GENERATION_ROOT: store,
    DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(root, 'copy.lock'), DEPENDENCY_GENERATION_FORCE_COPY: '1' };
  const shell = (file: string, args: string[], extra = {}) => spawnSync('bash', [file, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000 });
  const publish = () => {
    const result = shell(generationScript, ['--integration', donor, '--generation-root', store]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
  };
  return { root, donor, dest, store, env, shell, publish, snapshotHelper, generationScript };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('bounded independent verifier copy', () => {
  it('preserves cross-package aliases, executable files and literal symlinks without borrowing source inodes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'verifier-copy-')); roots.push(parent);
    const source = join(parent, 'source'), dest = join(parent, 'copy');
    for (let i = 0; i < 24; i++) write(source, `pkg-${i}/index.js`, `module.exports = ${i};\n`);
    write(source, 'pkg-0/cli', '#!/bin/sh\nprintf COPY_EXEC_OK\n');
    chmodSync(join(source, 'pkg-0/cli'), 0o555);
    linkSync(join(source, 'pkg-0/cli'), join(source, 'pkg-23/alias with\nnewline'));
    symlinkSync('../pkg-0/cli', join(source, 'pkg-12/bin'));
    await copyDependencyTree(source, dest, '--reflink=auto');
    const cli = join(dest, 'pkg-0/cli'), alias = join(dest, 'pkg-23/alias with\nnewline');
    expect(statSync(cli).ino).not.toBe(statSync(join(source, 'pkg-0/cli')).ino);
    expect(statSync(cli).ino).toBe(statSync(alias).ino);
    expect(statSync(cli).mode & 0o777).toBe(0o555);
    expect(readlinkSync(join(dest, 'pkg-12/bin'))).toBe('../pkg-0/cli');
    expect(execFileSync(cli, { encoding: 'utf8' })).toBe('COPY_EXEC_OK');
    chmodSync(cli, 0o755);
    writeFileSync(alias, 'private copy');
    expect(readFileSync(cli, 'utf8')).toBe('private copy');
    expect(readFileSync(join(source, 'pkg-0/cli'), 'utf8')).toContain('COPY_EXEC_OK');
    expect(readdirSync(dest).sort()).toEqual(readdirSync(source).sort());
  });

  it('rejects nesting into the source and retains empty trees', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'verifier-copy-empty-')); roots.push(parent);
    const source = join(parent, 'source'); mkdirSync(source);
    await expect(copyDependencyTree(source, join(source, 'nested'), '--reflink=auto')).rejects.toThrow('copy-inside-source');
    expect(existsSync(join(source, 'nested'))).toBe(false);
    const dest = join(parent, 'copy');
    await copyDependencyTree(source, dest, '--reflink=auto');
    expect(readdirSync(dest)).toEqual([]);
  });

  it('uses the bounded copy through the maintained materializer and refuses a missing source', () => {
    const f = fixture();
    const source = join(f.donor, 'node_modules'), dest = join(f.root, 'materialized');
    const run = (input: string, output: string, env: NodeJS.ProcessEnv = f.env) => spawnSync('bash', ['-c',
      'set -euo pipefail; source "$1"; dependency_generation_materialize_tree "$2" "$3" verifier',
      'verifier-copy', f.generationScript, input, output], { env, encoding: 'utf8', timeout: 30000 });
    const forbidden = join(f.root, 'forbidden-helper.mjs');
    writeFileSync(forbidden, 'process.stderr.write("SMALL_COPY_STARTED_HELPER");process.exit(99);');
    const small = run(source, join(f.root, 'small'), { ...f.env, DEPENDENCY_GENERATION_VERIFIER_HELPER: forbidden });
    expect(small.status, small.stderr).toBe(0);
    expect(small.stderr).not.toContain('SMALL_COPY_STARTED_HELPER');
    for (let i = 0; i < 64; i++) write(source, `pkg-${i}/index.js`, `module.exports = ${i};\n`);
    const result = run(source, dest);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('published dependency');
    expect(statSync(join(dest, 'pkg/index.js')).ino).not.toBe(statSync(join(source, 'pkg/index.js')).ino);
    const absent = join(f.root, 'not-published');
    expect(run(join(f.root, 'missing'), absent).status).not.toBe(0);
    expect(existsSync(absent)).toBe(false);
    const commands = join(f.root, 'commands');
    write(commands, 'cp', '#!/bin/sh\nexit 17\n'); chmodSync(join(commands, 'cp'), 0o755);
    const failed = run(source, absent, { ...f.env, PATH: commands + ':' + process.env.PATH });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('copy-worker-failed:status=17');
    expect(existsSync(absent)).toBe(false);
  }, 60000);
});

describe('D012 native generation closure', () => {
  it.each(['available', 'missing', 'incompatible', 'corrupt'])('prefers an immutable %s donor when native ref inputs match live inputs', async donorState => {
    const workspace = 'packages/omp-plugin';
    const f = fixture(workspace);
    const previous = f.publish();
    const retained = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', 'HEAD', '--retain-as', 'immutable-donor-baseline-test']);
    expect(retained.status, retained.stderr).toBe(0);
    const input = f.shell(f.generationScript, ['--integration', f.donor, '--fingerprint-ref', 'HEAD'])
      .stdout.match(/\binput=([a-f0-9]{64})/)![1]!;
    const selector = join(f.store, '.inputs', input);
    if (donorState === 'missing') rmSync(selector);
    if (donorState === 'corrupt')
      writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
    const lock = JSON.parse(readFileSync(join(f.donor, 'package-lock.json'), 'utf8'));
    lock.packages[''] = { dependencies: { pkg: donorState === 'incompatible' ? '2.0.0' : '1.0.0' } };
    if (donorState === 'incompatible') {
      lock.packages['node_modules/pkg'].version = '2.0.0';
      write(f.donor, 'node_modules/pkg/package.json', '{"name":"pkg","version":"2.0.0"}');
    }
    write(f.donor, 'package-lock.json', JSON.stringify(lock));
    execFileSync('git', ['add', 'package-lock.json'], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'equivalent exact inputs with mutable live output'], { cwd: f.donor });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
    const archive = join(f.root, 'immutable-donor-source'), pin = join(f.root, 'immutable-donor.json');
    const receipt = await prepareVerifierSource({ repo: f.donor, ref, dest: archive,
      inputs: [workspace + '/src/cli.cjs'] });
    writeFileSync(pin, JSON.stringify(receipt));
    write(f.donor, 'node_modules/pkg/index.js', 'mutable live dependency');
    const result = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', archive, '--retain-as', 'immutable-donor-test'], {
      VERIFY_TAURI_SOURCE_RECEIPT: pin, VERIFY_TAURI_SOURCE_REF: ref,
    });
    if (donorState === 'corrupt') {
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    } else {
      expect(result.status, result.stderr.slice(-12000)).toBe(0);
      const generation = result.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
      expect(readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8'))
        .toBe(donorState === 'available' ? 'published dependency' : 'mutable live dependency');
      expect(result.stderr.includes('install-equivalent prewarmed generation')).toBe(donorState === 'available');
    }
    expect(readFileSync(join(previous, 'tree/node_modules/pkg/index.js'), 'utf8')).toBe('published dependency');
    expect(readFileSync(join(f.donor, 'node_modules/pkg/index.js'), 'utf8')).toBe('mutable live dependency');
    expect(existsSync(join(archive, 'node_modules'))).toBe(false);
    const scratch = join(f.donor, '.papercusp/dependency-exact-ref');
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
  }, 120_000);

  it('rebuilds and reuses native closure from an independently pinned archive with tracked runtime output removed', async () => {
    const workspace = 'packages/omp-plugin';
    const f = fixture(workspace);
    const runtime = 'papercusp-desktop/src-tauri/resources/workbench-install.js';
    write(f.donor, runtime, 'historical generated runtime');
    execFileSync('git', ['add', runtime], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'historical tracked runtime'], { cwd: f.donor });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
    buildWorkspace(f.donor, workspace, [process.execPath, 'build.cjs']);
    const previous = f.publish();
    const previousClosure = readFileSync(join(previous, '.verifier-closure.json'), 'utf8');
    const archive = join(f.root, 'archive'), receiptPath = join(f.root, 'archive.json');
    const receipt = await prepareVerifierSource({ repo: f.donor, ref, dest: archive,
      inputs: [workspace + '/src/cli.cjs'] });
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const pins = { VERIFY_TAURI_SOURCE_RECEIPT: receiptPath, VERIFY_TAURI_SOURCE_REF: ref };
    expect(existsSync(join(archive, '.git'))).toBe(false);
    expect(existsSync(join(archive, runtime))).toBe(false);
    const stale = f.shell(f.snapshotHelper, ['preflight-generation', f.donor, archive], pins);
    expect(stale.status).toBe(74);
    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', archive, '--retain-as', 'native-archive-test'];
    const rebuilt = f.shell(f.generationScript, args, pins);
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(rebuilt.stdout).toContain('reused=false');
    const generation = rebuilt.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(generation).not.toBe(previous);
    const closure = JSON.parse(readFileSync(join(generation, '.verifier-closure.json'), 'utf8'));
    expect(closure.complete).toBe(true);
    expect(closure.workspaces[0].inputs.some((input: { path: string }) => input.path === runtime)).toBe(false);
    expect(readFileSync(join(previous, '.verifier-closure.json'), 'utf8')).toBe(previousClosure);
    expect(existsSync(join(archive, 'node_modules'))).toBe(false);
    expect(existsSync(join(archive, workspace, 'dist'))).toBe(false);
    const reused = f.shell(f.generationScript, args, pins);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(reused.stdout).toContain('path=' + generation);
    const copied = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, archive], pins);
    expect(copied.status, copied.stderr).toBe(0);
    expect(spawnSync(process.execPath, [join(archive, 'node_modules/.bin/probe')], { encoding: 'utf8' }).stdout)
      .toBe('frozen-workspace\n');
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', f.store);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', ref);
    try {
      const binding = await bindFrozenDependencyGeneration(archive, ref);
      expect(binding.identity.dependencyGeneration).toBe(generation.split('/').pop());
      await binding.assertUnchanged();
      await expect(bindFrozenDependencyGeneration(archive, '0'.repeat(40)))
        .rejects.toThrow('source ref');
      write(archive, workspace + '/src/cli.cjs', 'changed after binding');
      await expect(binding.assertUnchanged()).rejects.toThrow('tampered verification source archive');
    } finally { vi.unstubAllEnvs(); }
    expect(readdirSync(join(f.store, '.papercusp/dependency-exact-ref'))).toEqual([]);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
  }, 120_000);

  it.each([32, 300])('reports advancing source and input censuses without changing custody (%s files)', async count => {
    const f = fixture();
    for (let index = 0; index < count; index++) write(f.donor, 'inputs/' + index + '.txt', String(index));
    execFileSync('git', ['add', '.'], { cwd: f.donor });
    execFileSync('git', ['commit', '-qm', 'source census progress fixture'], { cwd: f.donor });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
    const archive = join(f.root, 'progress-archive'), receiptPath = join(f.root, 'progress-archive.json');
    const receipt = await prepareVerifierSource({ repo: f.donor, ref, dest: archive,
      inputs: ['inputs/0.txt'] });
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const run = () => spawnSync(process.execPath,
      [join(repo, 'apps/operator/bin/release/dependency-generation-verifier.mjs'), 'fingerprint', archive], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env,
          VERIFY_TAURI_SOURCE_RECEIPT: receiptPath, VERIFY_TAURI_SOURCE_REF: ref },
      });
    const first = run(), second = run();
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(second.stdout).toBe(first.stdout);
    const scans = new Map<string, number>();
    for (const line of first.stderr.trim().split('\n')) {
      const match = /^verifier census progress: scan=(\d+:\d+) checked=(\d+)$/.exec(line);
      expect(match, line).not.toBeNull();
      const completed = Number(match![2]);
      expect(completed).toBeGreaterThan(scans.get(match![1]) ?? 0);
      expect(completed).toBeLessThanOrEqual(receipt.files.length);
      scans.set(match![1], completed);
    }
    // A freshly verified archive projects its measured inputs without a
    // redundant second census. Progress must still cover a real scan.
    expect(scans.size).toBeGreaterThanOrEqual(1);
    write(archive, 'inputs/0.txt', 'changed');
    const tampered = run();
    expect(tampered.status).toBe(74);
    expect(tampered.stderr).toContain('tampered verification source archive');
  });

  it.each(['missing-pin', 'internal-pin', 'wrong-ref', 'receipt', 'source', 'extra'])
    ('refuses %s archive custody before measuring native build inputs', async defect => {
      const f = fixture('packages/omp-plugin');
      const archive = join(f.root, 'archive'), receiptPath = join(f.root, 'archive.json');
      const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
      const receipt = await prepareVerifierSource({ repo: f.donor, ref, dest: archive,
        inputs: ['packages/omp-plugin/src/cli.cjs'] });
      writeFileSync(receiptPath, JSON.stringify(receipt));
      vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
      vi.stubEnv('VERIFY_TAURI_SOURCE_REF', ref);
      try {
        checkSource(archive, ref);
        expect(buildInputs(archive).map((input: { path: string }) => input.path))
          .toContain('packages/omp-plugin/src/cli.cjs');
        if (defect === 'missing-pin') vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');
        if (defect === 'internal-pin') vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', join(archive, '.verifier-source.json'));
        if (defect === 'wrong-ref') vi.stubEnv('VERIFY_TAURI_SOURCE_REF', '0'.repeat(40));
        if (defect === 'receipt') writeFileSync(join(archive, '.verifier-source.json'), JSON.stringify({ ...receipt, sourceCommit: '0'.repeat(40) }));
        if (defect === 'source') write(archive, 'packages/omp-plugin/src/cli.cjs', 'tampered');
        if (defect === 'extra') write(archive, 'unrecorded.cjs', 'unrecorded');
        expect(() => checkSource(archive, ref)).toThrow();
        expect(() => buildInputs(archive)).toThrow();
      } finally { vi.unstubAllEnvs(); }
    });

  it.each(['source-stale', 'incomplete'])('rebuilds a %s exact-ref native closure with unchanged locks, then reuses it', async defect => {
    const f = fixture();
    if (defect === 'incomplete') rmSync(join(f.donor, 'packages/cli/dist/.papercusp-workspace-build.json'));
    const before = f.publish();
    const oldClosure = readFileSync(join(before, '.verifier-closure.json'), 'utf8');
    // Only source changes; the lock/patch key still selects the old generation.
    write(f.dest, 'packages/cli/src/cli.cjs', 'console.log("new-exact-source");\n');
    execFileSync('git', ['add', 'packages/cli/src/cli.cjs'], { cwd: f.dest });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'new exact source with unchanged dependencies'], { cwd: f.dest });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    // The donor knows the commit but its working source remains at the old ref.
    execFileSync('git', ['fetch', f.dest, ref], { cwd: f.donor });
    const stale = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(stale.status).toBe(74);
    expect(stale.stderr, stale.stdout + stale.stderr)
      .toContain(defect === 'incomplete' ? 'incomplete-closure'
        : 'selected-source-population-mismatch:packages/cli/dist');

    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest, '--retain-as', 'native-exact-test'];
    const buildReceipt = join(f.root, 'native-build-root');
    const rebuilt = f.shell(f.generationScript, args, {
      NATIVE_BUILD_PARENT: f.store, NATIVE_BUILD_RECEIPT: buildReceipt,
    });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(readFileSync(buildReceipt, 'utf8')
      .startsWith(join(f.store, '.papercusp/dependency-exact-ref/native-'))).toBe(true);
    expect(rebuilt.stdout).toContain('reused=false');
    const after = rebuilt.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(after).not.toBe(before);
    expect(readFileSync(join(after, 'tree/packages/cli/dist/cli.cjs'), 'utf8')).toContain('new-exact-source');
    expect(readFileSync(join(before, '.verifier-closure.json'), 'utf8')).toBe(oldClosure);
    if (defect === 'source-stale')
      expect(readFileSync(join(before, 'tree/packages/cli/dist/cli.cjs'), 'utf8')).toContain('frozen-workspace');
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, 'packages/cli/dist'))).toBe(false);
    const donorScratch = join(f.donor, '.papercusp/dependency-exact-ref');
    expect(existsSync(donorScratch) ? readdirSync(donorScratch) : []).toEqual([]);
    expect(readdirSync(join(f.store, '.papercusp/dependency-exact-ref'))).toEqual([]);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    const compatible = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(compatible.status, compatible.stderr).toBe(0);
    // Another source with the same locks can republish its dependency selector
    // without invalidating this frozen native source's closure or proof.
    expect(f.publish()).toBe(before);
    const republished = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(republished.status, republished.stderr).toBe(0);
    const reused = f.shell(f.generationScript, args);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(reused.stdout).toContain('path=' + after);
    const materialized = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(spawnSync(process.execPath, [join(f.dest, 'node_modules/.bin/probe')], { encoding: 'utf8' }).stdout)
      .toBe('new-exact-source\n');
    expect(readFileSync(join(f.dest, '.papercusp-pinned-deps'), 'utf8')).toMatch(/selector=native-[0-9a-f]{64}/);
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', f.store);
    try {
      const binding = await bindFrozenDependencyGeneration(f.dest, ref);
      expect(binding.identity.dependencyGeneration).toBe(after.split('/').pop());
      await binding.assertUnchanged();
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);

  it('runVerifierCommand refreshes a stale closure from the nested managed-client source before child setup', async () => {
    const workspace = 'apps/operator-vite';
    const managedClient = workspace + '/src/lib/nuqs-tanstack-router-adapter.tsx';
    const f = fixture(workspace);
    installTsxRuntime(f);
    // These two frozen CLI probes are outside this test's contract. Keep them
    // minimal while the parent source checks and dependency-generation helper
    // remain real.
    write(f.donor, 'scripts/source-preview.mjs', [
      "const operation = process.argv[2];",
      "if (operation === 'verifier-inputs-check') console.log('inputs-ok');",
      "else if (operation === 'verifier-measure') console.log('4096');",
      "else { console.error('unsupported fixture operation: ' + operation); process.exitCode = 2; }",
      '',
    ].join('\n'));
    execFileSync('git', ['add', 'package.json', 'package-lock.json', 'scripts/source-preview.mjs'], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture tsx runtime closure'], { cwd: f.donor });
    const build = [
      "const fs = require('node:fs');",
      "const source = fs.readFileSync('src/lib/nuqs-tanstack-router-adapter.tsx', 'utf8');",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/cli.cjs', source);",
      '',
    ].join('\n');

    write(f.donor, managedClient, 'export const marker = "managed-client-source-A";\n');
    write(f.donor, workspace + '/build.cjs', build);
    execFileSync('git', ['add', managedClient, workspace + '/build.cjs'], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'managed client source A'], { cwd: f.donor });
    const refA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
    buildWorkspace(f.donor, workspace, [process.execPath, 'build.cjs']);
    const before = f.publish();
    const beforeClosure = JSON.parse(readFileSync(join(before, '.verifier-closure.json'), 'utf8'));
    expect(beforeClosure.complete).toBe(true);
    expect(readFileSync(join(before, 'tree', workspace, 'dist/cli.cjs'), 'utf8'))
      .toContain('managed-client-source-A');

    write(f.donor, managedClient, 'export const marker = "managed-client-source-B";\n');
    execFileSync('git', ['add', managedClient], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'managed client source B with unchanged locks'], { cwd: f.donor });
    const refB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
    const verifierHelpers = [
      'libs/test-config/src/tracked-files.mjs',
      'libs/test-config/src/git-index-fault-core.mjs',
    ];
    for (const path of verifierHelpers) {
      expect(existsSync(join(f.root, 'tooling', path))).toBe(true);
      expect(execFileSync('git', ['ls-tree', '-r', '--name-only', refB, '--', path], {
        cwd: f.donor, encoding: 'utf8',
      }).trim()).toBe(path);
    }
    for (const lock of ['package-lock.json', 'papercusp-desktop/package-lock.json']) {
      expect(execFileSync('git', ['show', `${refB}:${lock}`], { cwd: f.donor }))
        .toEqual(execFileSync('git', ['show', `${refA}:${lock}`], { cwd: f.donor }));
    }

    const childMarker = join(f.root, 'verifier-child-started');
    const observedWorkspaceOutput: string[] = [];
    const prepareChildEnv = vi.fn(async ({ sourceRoot }: { sourceRoot: string }) => {
      observedWorkspaceOutput.push(readFileSync(join(sourceRoot, workspace, 'dist/cli.cjs'), 'utf8'));
      throw new Error('fixture stop before verifier child setup');
    });
    const receiptPath = join(f.root, 'source-preview-managed-client.json');
    await expect(runVerifierCommand({
      repo: f.donor,
      ref: refB,
      receiptPath,
      inputs: [managedClient],
      env: f.env,
      prepareChildEnv,
      command: [process.execPath, '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(childMarker)}, 'started')`],
    })).rejects.toThrow('fixture stop before verifier child setup');
    expect(prepareChildEnv).toHaveBeenCalledTimes(1);
    expect(observedWorkspaceOutput).toHaveLength(1);
    expect(observedWorkspaceOutput[0]).toContain('managed-client-source-B');
    expect(existsSync(childMarker)).toBe(false);

    const archive = join(f.root, 'managed-client-source-B-archive');
    const receipt = await prepareVerifierSource({ repo: f.donor, ref: refB, dest: archive,
      inputs: [managedClient] });
    const receiptFile = join(f.root, 'managed-client-source-B-receipt.json');
    writeFileSync(receiptFile, JSON.stringify(receipt));
    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', refB, '--verifier-source', archive, '--retain-as', 'managed-client-closure-test'];
    const reused = f.shell(f.generationScript, args, {
      VERIFY_TAURI_SOURCE_RECEIPT: receiptFile, VERIFY_TAURI_SOURCE_REF: refB,
    });
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    const after = reused.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(after).not.toBe(before);
    const closure = JSON.parse(readFileSync(join(after, '.verifier-closure.json'), 'utf8'));
    expect(closure.complete).toBe(true);
    const workspaceClosure = closure.workspaces.find((entry: { output: string }) => entry.output === workspace + '/dist');
    expect(workspaceClosure.inputs.map((input: { path: string }) => input.path)).toContain(managedClient);
    expect(readFileSync(join(after, 'tree', workspace, 'dist/cli.cjs'), 'utf8'))
      .toContain('managed-client-source-B');
    expect(readFileSync(join(before, 'tree', workspace, 'dist/cli.cjs'), 'utf8'))
      .toContain('managed-client-source-A');
    expect(existsSync(join(archive, 'node_modules'))).toBe(false);
    expect(existsSync(join(archive, workspace, 'dist'))).toBe(false);
  }, 120_000);

  it('keeps the native publication leased through exact-input selection and ref pinning', () => {
    const f = fixture();
    f.publish();
    write(f.dest, 'packages/cli/src/cli.cjs', 'console.log("native-handoff");\n');
    execFileSync('git', ['add', 'packages/cli/src/cli.cjs'], { cwd: f.dest });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'native handoff source'], { cwd: f.dest });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    execFileSync('git', ['fetch', f.dest, ref], { cwd: f.donor });
    const wrapper = join(f.root, 'native-handoff.sh');
    const interleaved = join(f.root, 'retention-interleaved');
    const buildReceipt = join(f.root, 'native-build-root');
    writeFileSync(wrapper, [
      'set -euo pipefail',
      'source "$GENERATION_SCRIPT"',
      'eval "$(declare -f dependency_generation_select_prevalidated | sed \'1s/dependency_generation_select_prevalidated/original_select_prevalidated/\')"',
      'dependency_generation_select_prevalidated() {',
      '  if [ -f "$NATIVE_BUILD_RECEIPT" ] && [ ! -f "$INTERLEAVED" ]; then',
      '    touch "$INTERLEAVED"',
      // A retired-store sweep admits zero recency roots. Only real process
      // leases or ref pins may preserve a generation across this handoff.
      '    dependency_generation_apply_retention "$STORE" "$DONOR" 0 || return $?',
      '  fi',
      '  original_select_prevalidated "$@"',
      '}',
      'dependency_generation_main "$@"',
    ].join('\n'));
    const result = f.shell(wrapper, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest, '--retain-as', 'native-handoff-test'], {
      GENERATION_SCRIPT: f.generationScript, STORE: f.store, DONOR: f.donor, INTERLEAVED: interleaved,
      NATIVE_BUILD_PARENT: f.store, NATIVE_BUILD_RECEIPT: buildReceipt,
    });
    expect(existsSync(interleaved), result.stderr).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    const generation = result.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(readFileSync(join(generation, 'tree/packages/cli/dist/cli.cjs'), 'utf8')).toContain('native-handoff');
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    const sweep = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store, '--prune-only']);
    expect(sweep.status, sweep.stderr).toBe(0);
    expect(existsSync(generation)).toBe(true);
  }, 120_000);

  it('keeps its published native identity when another source replaces the ordinary input selector', () => {
    const f = fixture();
    const before = f.publish();
    write(f.dest, 'packages/cli/src/cli.cjs', 'console.log("native-selector-handoff");\n');
    execFileSync('git', ['add', 'packages/cli/src/cli.cjs'], { cwd: f.dest });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'native selector handoff source'], { cwd: f.dest });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    execFileSync('git', ['fetch', f.dest, ref], { cwd: f.donor });
    const wrapper = join(f.root, 'native-selector-handoff.sh');
    const interleaved = join(f.root, 'publisher-interleaved');
    const buildReceipt = join(f.root, 'native-build-root');
    writeFileSync(wrapper, [
      'set -euo pipefail',
      'source "$GENERATION_SCRIPT"',
      'eval "$(declare -f dependency_generation_main | sed \'1s/dependency_generation_main/original_dependency_generation_main/\')"',
      'dependency_generation_main() {',
      '  original_dependency_generation_main "$@" || return $?',
      '  if [ "$2" != "$DONOR" ] && [ -f "$NATIVE_BUILD_RECEIPT" ] && [ ! -f "$INTERLEAVED" ]; then',
      // A separate publisher shares lock inputs but has older source/CLI bytes.
      // Its shell must not overwrite the native publisher's identity globals.
      '    bash "$GENERATION_SCRIPT" --integration "$DONOR" --generation-root "$STORE" > "$INTERLEAVED" || return $?',
      '  fi',
      '}',
      'dependency_generation_main "$@"',
    ].join('\n'));
    const result = f.shell(wrapper, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest, '--retain-as', 'native-selector-handoff-test'], {
      GENERATION_SCRIPT: f.generationScript, STORE: f.store, DONOR: f.donor, INTERLEAVED: interleaved,
      NATIVE_BUILD_PARENT: f.store, NATIVE_BUILD_RECEIPT: buildReceipt,
    });
    expect(existsSync(interleaved), result.stderr).toBe(true);
    expect(readFileSync(interleaved, 'utf8')).toContain('path=' + before);
    expect(result.status, result.stderr).toBe(0);
    const generation = result.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(generation).not.toBe(before);
    expect(readFileSync(join(generation, 'tree/packages/cli/dist/cli.cjs'), 'utf8'))
      .toContain('native-selector-handoff');
    const compatible = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    const sweep = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store, '--prune-only']);
    expect(sweep.status, sweep.stderr).toBe(0);
    expect(existsSync(generation)).toBe(true);
  }, 120_000);

  it('refuses a corrupt native selector instead of falling back to a valid dependency selector', () => {
    const f = fixture();
    f.publish();
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest];
    const indexed = f.shell(f.generationScript, args);
    expect(indexed.status, indexed.stderr).toBe(0);
    const key = readdirSync(join(f.store, '.inputs')).find(name => name.startsWith('native-'))!;
    expect(key).toMatch(/^native-[0-9a-f]{64}$/);
    const selector = join(f.store, '.inputs', key);
    writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
    for (const [file, argv] of [[f.generationScript, args],
      [f.snapshotHelper, ['preflight-generation', f.dest, f.dest]],
      [f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]]] as const) {
      const refused = f.shell(file, [...argv]);
      expect(refused.status, refused.stderr).toBe(74);
    }
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
  }, 120_000);

  it('refuses dirty native source before publishing or changing the existing selector', () => {
    const f = fixture(), generation = f.publish();
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    write(f.dest, 'packages/cli/src/cli.cjs', 'dirty source');
    const result = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest]);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('dirty-verifier-source');
    expect(f.publish()).toBe(generation);
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
  }, 120_000);

  it.each([false, true])('runs the source-preview command from a generation without a physical dependency donor (archive=%s)', async archiveMode => {
    const workspace = 'packages/omp-plugin';
    const f = fixture(workspace);
    write(f.donor, '.gitignore', 'node_modules/\ndist/\n/.papercusp/scratch/\n');
    // The fixture CLI has no TypeScript imports. Its private loader package is
    // still resolved through the real --import tsx preparation path.
    write(f.donor, 'scripts/source-preview.mjs',
      'console.log(process.argv.includes("verifier-measure") ? "4096" : "inputs-ok");\n');
    const lock = JSON.parse(readFileSync(join(f.donor, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/tsx'] = { version: '4.0.0' };
    write(f.donor, 'package-lock.json', JSON.stringify(lock));
    write(f.donor, 'node_modules/tsx/package.json',
      '{"name":"tsx","version":"4.0.0","type":"module","exports":"./index.mjs"}');
    write(f.donor, 'node_modules/tsx/index.mjs', 'export {};\n');
    const runtime = 'papercusp-desktop/src-tauri/resources/workbench-install.js';
    if (archiveMode) write(f.donor, runtime, 'historical generated runtime');
    execFileSync('git', ['add', '.gitignore', 'package-lock.json', 'scripts/source-preview.mjs'], { cwd: f.donor });
    if (archiveMode) execFileSync('git', ['add', runtime], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'source-preview generation command inputs'], { cwd: f.donor });
    buildWorkspace(f.donor, workspace, [process.execPath, 'build.cjs']);
    let generation = f.publish();
    if (archiveMode) {
      const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.donor, encoding: 'utf8' }).trim();
      const archive = join(f.root, 'prewarm-source'), pin = join(f.root, 'prewarm.json');
      const receipt = await prepareVerifierSource({ repo: f.donor, ref, dest: archive,
        inputs: ['scripts/source-preview.mjs'] });
      writeFileSync(pin, JSON.stringify(receipt));
      const prewarm = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store,
        '--ensure-ref', ref, '--verifier-source', archive], {
        VERIFY_TAURI_SOURCE_RECEIPT: pin, VERIFY_TAURI_SOURCE_REF: ref,
      });
      expect(prewarm.status, prewarm.stderr).toBe(0);
      generation = prewarm.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    }
    for (const path of ['node_modules', workspace + '/dist', 'papercusp-desktop/node_modules'])
      rmSync(join(f.donor, path), { recursive: true });
    const receiptPath = join(f.root, 'command.json');
    const env = { ...f.env, NODE_OPTIONS: '', NODE_PATH: '',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 300_000) };
    const code = await runVerifierCommand({ repo: f.donor, ref: 'HEAD', receiptPath,
      inputs: ['scripts/source-preview.mjs'], env,
      command: [process.execPath, 'node_modules/.bin/probe'],
      prepareChildEnv: async ({ sourceRoot }) => {
        if (archiveMode) {
          expect(existsSync(join(sourceRoot, '.git'))).toBe(false);
          expect(existsSync(join(sourceRoot, runtime))).toBe(false);
          write(sourceRoot, runtime, 'new private runtime');
        }
        for (const path of ['node_modules/pkg/index.js', workspace + '/dist/cli.cjs',
          'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'])
          expect(statSync(join(sourceRoot, path)).ino).not.toBe(statSync(join(generation, 'tree', path)).ino);
        return {};
      } });
    expect(code).toBe(0);
    const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(phases.find(row => row.phase === 'deps.snapshot' && row.event === 'started').snapshotSelection)
      .toMatchObject({ explicitGeneration: true, command: 'snapshot-generation-locked' });
    expect(phases.filter(row => row.event === 'completed').map(row => row.phase))
      .toEqual(expect.arrayContaining(['source.freeze', 'deps.snapshot', 'deps.inputs', 'deps.measure',
        'deps.census', 'child.run', 'deps.postverify', 'source.postverify', 'cleanup']));
    expect(JSON.parse(readFileSync(receiptPath + '.dependencies.after.json', 'utf8')))
      .toEqual(JSON.parse(readFileSync(receiptPath + '.dependencies.json', 'utf8')));
    const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
    expect(task.cleanup).toBe('completed');
    expect(existsSync(task.ownedRoot)).toBe(false);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
  }, 120_000);

  it('consumes leased workspace and exact desktop closures with donor reads refused and private inodes', async () => {
    const f = fixture(), generation = f.publish();
    rmSync(join(f.donor, 'node_modules'), { recursive: true });
    rmSync(join(f.donor, 'packages/cli/dist'), { recursive: true });
    rmSync(join(f.donor, 'papercusp-desktop/node_modules'), { recursive: true });
    const preflight = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(preflight.status, preflight.stderr).toBe(0);
    const child = nativeVerifierEnv(f.env, { repoRoot: f.dest });
    expect(child.PAPERCUSP_REPO_DIR).toBe(f.dest);
    expect(child.VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE).toBe('copy');
    expect(selectVerifierDependencySnapshot('hardlink', true, true).command).toBe('snapshot-generation-locked');
    expect(() => selectVerifierDependencySnapshot('hardlink', false, true)).toThrow('does not support');
    const shellSource = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const cliCheck = shellSource.match(/^preflight_desktop_tauri_cli\(\) \{[\s\S]*?^\}/m)![0];
    const earlyCheck = spawnSync('bash', ['-c', cliCheck + '\npreflight_desktop_tauri_cli'], {
      env: { ...f.env, REPO_DIR: f.dest, DESKTOP_DIR: join(f.dest, 'papercusp-desktop'),
        VERIFY_TAURI_SOURCE_REF: child.VERIFY_TAURI_SOURCE_REF }, encoding: 'utf8', timeout: 30_000,
    });
    expect(earlyCheck.status, earlyCheck.stderr).toBe(0);
    const size = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest, 'size']);
    expect(size.status, size.stderr).toBe(0);
    expect(Number(size.stdout.trim())).toBeGreaterThan(0);
    const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('DONOR_READ_FORBIDDEN');
    const launched = spawnSync(process.execPath, [join(f.dest, 'node_modules/.bin/probe')], { encoding: 'utf8' });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toBe('frozen-workspace\n');
    for (const path of ['node_modules/pkg/index.js', 'packages/cli/dist/cli.cjs',
      'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'])
      expect(statSync(join(f.dest, path)).ino).not.toBe(statSync(join(generation, 'tree', path)).ino);
    expect(readFileSync(join(f.dest, '.papercusp-pinned-deps'), 'utf8')).toContain('mode=generation-copy');
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', f.store);
    try {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
      const binding = await bindFrozenDependencyGeneration(f.dest, commit);
      await binding.assertUnchanged();
      const output = join(f.dest, 'packages/cli/dist/cli.cjs');
      chmodSync(output, 0o644); writeFileSync(output, 'tampered materialized output');
      await expect(binding.assertUnchanged()).rejects.toThrow('stale-workspace-output');
      await expect(bindFrozenDependencyGeneration(f.dest, commit)).rejects.toThrow('stale-workspace-output');
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);

  it.each(['source', 'added-source', 'output', 'receipt', 'desktop-lock', 'missing-desktop', 'publication'])(
    'refuses %s custody before copying dependencies', defect => {
      const f = fixture(), generation = f.publish();
      if (defect === 'source') write(f.dest, 'packages/cli/src/cli.cjs', 'changed selected source');
      if (defect === 'added-source') write(f.dest, 'packages/cli/src/new.cjs', 'new source');
      if (defect === 'desktop-lock') write(f.dest, 'papercusp-desktop/package-lock.json', '{}');
      if (defect === 'output') {
        const path = join(generation, 'tree/packages/cli/dist/cli.cjs'); chmodSync(path, 0o644); writeFileSync(path, 'changed output');
      }
      if (defect === 'receipt') rmSync(join(generation, '.verifier-closure.json'));
      if (defect === 'missing-desktop') rmSync(join(generation, 'tree/papercusp-desktop/node_modules'), { recursive: true });
      if (defect === 'publication') {
        const path = join(generation, '.papercusp-dependency-generation'); chmodSync(path, 0o644);
        writeFileSync(path, readFileSync(path, 'utf8').replace(/^publication_token=.*$/m, 'publication_token=v3:' + '0'.repeat(64)));
      }
      const preflight = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
      expect(preflight.status, preflight.stderr).not.toBe(0);
      expect(() => nativeVerifierEnv(f.env, { repoRoot: f.dest })).toThrow('generation preflight failed');
      const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
      expect(result.status, result.stderr).not.toBe(0);
      expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
      expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
      expect(result.stderr).not.toContain('DONOR_READ_FORBIDDEN');
      expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    }, 120_000);

  it('refuses a newly required dist bin with the same locks and a legitimately empty workspace receipt', () => {
    const f = fixture();
    write(f.donor, 'packages/cli/package.json', '{"name":"probe","bin":{"probe":"src/cli.cjs"}}');
    // No package/lock dependency changed; the selected source still needs the
    // generated dist bin which was absent from the producer's requirements.
    const generation = f.publish();
    expect(JSON.parse(readFileSync(join(generation, '.verifier-closure.json'), 'utf8')))
      .toMatchObject({ complete: true, workspaces: [] });
    const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('workspace-requirements-mismatch');
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
  }, 120_000);

  it('never blesses old output with new source hashes, and rebuilds under a new identity', () => {
    const f = fixture(), before = f.publish();
    write(f.donor, 'packages/cli/src/cli.cjs', 'console.log("rebuilt");\n');
    expect(captureClosure(f.donor)).toMatchObject({ complete: false,
      reason: expect.stringContaining('selected-source-population-mismatch:packages/cli/dist') });
    buildWorkspace(f.donor, 'packages/cli', [process.execPath, 'build.cjs']);
    expect(captureClosure(f.donor)).toMatchObject({ complete: true });
    expect(f.publish()).not.toBe(before);
  }, 120_000);

  it('rejects a failed or drifting producer without leaving a success receipt', () => {
    const f = fixture();
    expect(() => buildWorkspace(f.donor, 'packages/cli', [process.execPath, '-e', 'process.exit(2)'])).toThrow('build-failed');
    expect(existsSync(join(f.donor, 'packages/cli/dist/.papercusp-workspace-build.json'))).toBe(false);
    expect(() => buildWorkspace(f.donor, 'packages/cli', [process.execPath, '-e',
      'require("node:fs").writeFileSync("src/new.cjs","changed");'])).toThrow('source-changed-during-build');
  });
});
