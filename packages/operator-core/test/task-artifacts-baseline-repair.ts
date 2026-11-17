/** Test-only custody for the separately qualified D-004 dependency edition. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, type BigIntStats } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isCliEntry } from '../lib/util/cli-entry';
import type { NativeProofInput, NativeProofRun } from '../lib/testing-run-store';
// @ts-ignore -- reuse the maintained strict resolver, never a custom installer.
import { metadataRepairInputLayout, resolveMetadataRepairLock } from '../../../scripts/npm-install-safe.mjs';
import { auditTree, lockfilesFromManifest } from '../../../apps/operator/bin/release/dependency-lock-tree-audit.mjs';
import { baselineLockDelta, repairedBaselineEdition, type FrozenSource } from '../lib/task-artifacts-baseline-custody';
export * from '../lib/task-artifacts-baseline-custody';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type InstalledEntry = { path: string; mode: number } & (
  { kind: 'directory' } | { kind: 'file'; bytes: number; sha256: string }
  | { kind: 'link'; target: string; resolved: string });

/** Reuse the publisher's tree census and strict lock/runtime audit. Unlike its
 * metadata fingerprint, this receipt hashes ALL reachable file bytes, including
 * hidden files, native addons and workspace/link targets. There is no prefix or
 * page limit: a failed census/read rejects the entire observation. */
export async function captureBaselineInstalledTree(root: string,
  helperRoot = resolve(import.meta.dirname, '../../..')) {
  root = await realpath(root);
  const census = (operation: 'dependency_generation_enumerate_node_modules' | 'dependency_generation_input_manifest'
    = 'dependency_generation_enumerate_node_modules') => new Promise<string>((done, reject) => {
    const child = spawn('bash', ['-euo', 'pipefail', '-c',
      'source "$1"; "$3" "$2"', 'baseline-installed-tree',
      join(helperRoot, 'apps/operator/bin/release/dependency-generation.sh'), root, operation],
    { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(180_000),
      env: { ...process.env, DEPENDENCY_GENERATION_SCOPE_MODE: 'full' } });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done(Buffer.concat(output).toString())
      : reject(new Error('baseline_installed_census_failed:' + code + ':' + signal + ':' + Buffer.concat(errors))));
  });
  const inside = (path: string) => {
    const rel = relative(root, path);
    assert.ok(rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/')
      && !/[\x00-\x1f\\]/.test(rel), 'baseline_installed_path:' + path);
    return rel;
  };
  const treePaths = async () => (await census()).split('\n').filter(Boolean).map(path => inside(path)).sort();
  const trees = await treePaths();
  assert.ok(trees.includes('node_modules') && new Set(trees).size === trees.length,
    'baseline_installed_census_incomplete');
  // The full tree census includes standalone installs outside the selected
  // root workspace. Use the publisher's matching full input census as well.
  const inputManifest = await census('dependency_generation_input_manifest');
  const lockfiles = lockfilesFromManifest(inputManifest);
  const audit = auditTree({ treeRoot: root, lockRoot: root, lockfiles, installedTrees: trees });
  assert.deepEqual(audit.defects, [], 'baseline_installed_lock_audit:' + JSON.stringify(audit));
  const entries = new Map<string, InstalledEntry>();
  const same = (a: BigIntStats, b: BigIntStats) =>
    (['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key]);
  const visit = async (path: string): Promise<void> => {
    if (entries.has(path)) return;
    const file = join(root, path), before = await lstat(file, { bigint: true });
    const mode = Number(before.mode & 0o7777n);
    if (before.isSymbolicLink()) {
      const target = await readlink(file), resolved = inside(await realpath(file));
      entries.set(path, { path, mode, kind: 'link', target, resolved });
      await visit(resolved);
      assert.equal(await readlink(file), target, 'baseline_installed_link_changed:' + path);
    } else if (before.isDirectory()) {
      entries.set(path, { path, mode, kind: 'directory' });
      const names = (await readdir(file)).sort();
      for (const name of names) await visit(path + '/' + name);
      assert.deepEqual((await readdir(file)).sort(), names, 'baseline_installed_population_changed:' + path);
    } else {
      assert.ok(before.isFile(), 'baseline_installed_type:' + path);
      assert.ok(before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'baseline_installed_file_size:' + path);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(file)) hash.update(bytes);
      entries.set(path, { path, mode, kind: 'file', bytes: Number(before.size), sha256: hash.digest('hex') });
    }
    assert.ok(same(before, await lstat(file, { bigint: true })), 'baseline_installed_changed_during_read:' + path);
  };
  for (const tree of trees) {
    assert.ok(!(await lstat(join(root, tree))).isSymbolicLink(), 'baseline_installed_linked_root:' + tree);
    await visit(tree);
  }
  assert.deepEqual(await treePaths(), trees, 'baseline_installed_tree_population_changed');
  assert.equal(await census('dependency_generation_input_manifest'), inputManifest,
    'baseline_installed_lock_inputs_changed');
  const manifest = { schemaVersion: 1, trees, audit,
    entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...manifest, sha256: digest(JSON.stringify(manifest)) };
}

export async function assertBaselineInstalledTree(root: string,
  expected: Awaited<ReturnType<typeof captureBaselineInstalledTree>>, helperRoot?: string) {
  const actual = await captureBaselineInstalledTree(root, helperRoot);
  assert.deepEqual(actual, expected, 'baseline_installed_tree_changed');
}

/** Same selected CLI as the maintained metadata resolver and guarded ci. */
export function captureBaselineToolchain(): NativeProofInput['toolchain'] {
  const cli = realpathSync(join(dirname(process.execPath), 'npm'));
  const npmSha256 = digest(readFileSync(cli));
  const npmVersion = execFileSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  }).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, 'baseline_npm_version_invalid');
  assert.equal(digest(readFileSync(cli)), npmSha256, 'baseline_npm_changed_during_read');
  return { npmSha256, npmVersion, nodeVersion: process.version, nativeAbi: process.versions.modules };
}

export function assertBaselineToolchain(expected: NativeProofInput['toolchain']) {
  const actual = captureBaselineToolchain();
  assert.deepEqual(actual, expected, 'baseline_reviewed_toolchain_changed');
  return actual;
}

/** The fresh runtime child follows the original ledger's receipts, never a new
 * filesystem assertion of what was installed/built. Reuse before start and after
 * stop; a substituted receipt, manifest, tree or toolchain rejects the run. */
export async function assertBaselineRuntimeCustody(root: string, preparedDir: string,
  intent: { input: Pick<NativeProofInput, 'toolchain'>; fingerprint: string; events: NativeProofRun['events'] },
  helperRoot?: string, profile: 'dependency-edition' | 'native-recovery' = 'dependency-edition') {
  const files = {
    'dependency-edition': { installed: 'dependency-installed.json', built: 'dependency-edition-after-build.json',
      manifest: 'dependency-installed-tree.json', manifestHash: 'installedTreeManifestSha256' },
    'native-recovery': { installed: 'native-recovery-installed.json', built: 'native-recovery-built.json',
      manifest: 'native-recovery-installed-tree.json', manifestHash: 'manifestSha256' },
  }[profile];
  assert.ok(files, 'baseline_runtime_receipt_profile');
  const receipt = (kind: 'installed' | 'built', name: string) => {
    const events = intent.events.filter(event => event.kind === kind);
    assert.equal(events.length, 1, 'baseline_runtime_receipt_missing:' + kind);
    const event = events[0], path = join(preparedDir, name);
    assert.equal(event.fingerprint, intent.fingerprint, 'baseline_runtime_receipt_edition:' + kind);
    assert.equal(resolve(event.receiptRef!), resolve(path), 'baseline_runtime_receipt_path:' + kind);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'baseline_runtime_receipt_type:' + kind);
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), event.receiptSha256, 'baseline_runtime_receipt_changed:' + kind);
    return JSON.parse(bytes.toString());
  };
  const installed = receipt('installed', files.installed);
  const built = receipt('built', files.built);
  const manifestPath = join(preparedDir, files.manifest);
  assert.ok(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink(), 'baseline_runtime_manifest_type');
  const manifestBytes = readFileSync(manifestPath), manifestSha256 = digest(manifestBytes);
  assert.equal(manifestSha256, installed[files.manifestHash], 'baseline_runtime_manifest_changed');
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.sha256, installed.installedTreeSha256, 'baseline_runtime_installed_tree_identity');
  assert.equal(manifest.sha256, built.installedTreeSha256, 'baseline_runtime_built_tree_identity');
  const toolchain = assertBaselineToolchain(intent.input.toolchain);
  await assertBaselineInstalledTree(root, manifest, helperRoot);
  return { installedTreeSha256: manifest.sha256 as string,
    installedTreeManifestSha256: manifestSha256, toolchain };
}

export function assertFrozenBaselineSources(root: string, files: FrozenSource[]) {
  return files.map(file => {
    const path = resolve(root, file.path);
    assert.ok(path.startsWith(resolve(root) + '/'), 'baseline_source_path');
    assert.equal(digest(file.content), file.sha256, 'baseline_fixture_source_changed:' + file.path);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'baseline_source_type:' + file.path);
    const sha256 = digest(readFileSync(path));
    assert.equal(sha256, file.sha256, 'baseline_source_changed:' + file.path);
    return { path: file.path, sha256 };
  });
}

/** Absence is an input too; only the explicitly resolved lock may differ. */
export function assertBaselineRepairInputs(root: string, snapshot: Map<string, Buffer | null>,
  output?: { path: string; bytes: Buffer }) {
  assert.ok(!output || snapshot.has(output.path), 'baseline_repair_output_not_selected');
  assert.deepEqual(metadataRepairInputLayout(root).inputPaths, [...snapshot.keys()].sort(),
    'baseline_repair_input_population_changed');
  for (const [path, before] of snapshot) {
    const absolute = join(root, path);
    const expected = output?.path === path ? output.bytes : before;
    const actual = existsSync(absolute) ? readFileSync(absolute) : null;
    assert.ok(actual === null || (lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink()),
      'baseline_repair_input_type:' + path);
    assert.ok(expected === null ? actual === null : actual !== null && actual.equals(expected),
      'baseline_repair_input_changed:' + path);
  }
}

/** The complete original product tree may differ only by the declared lock. */
export function baselineProductBoundary(root: string, expectedChangedPaths: string[]) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const changedPaths = [...new Set([
    ...git(['diff', '--name-only', '-z', '--ignore-submodules=none', 'HEAD', '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z', '--']).split('\0'),
  ].filter(Boolean))].sort();
  assert.deepEqual(changedPaths, [...expectedChangedPaths].sort(), 'baseline_product_tree_changed');
  // Submodule dirtiness is reported as its path above; its commit identities
  // also stay in the immutable parent tree and are recorded explicitly here.
  return { sourceSha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    changedPaths, submodules: git(['submodule', 'status', '--recursive']) };
}

/** Retain rejected bytes as evidence only; never apply them to the source. */
export function retainBaselineRepairFailure(evidenceDir: string, error: unknown) {
  const failure = (error as { metadataRepairFailure?: {
    schemaVersion: number; stage: string;
    candidate: { path: string | null; bytes: Buffer | null; sha256: string | null;
      size: number | null; omission: string | null };
    resolution: { exitCode: number } | null;
    receipt: unknown;
  } })?.metadataRepairFailure;
  if (!failure) return;
  const { bytes, ...candidate } = failure.candidate;
  if (bytes !== null) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024, 'baseline_repair_failure_size');
    assert.equal(digest(bytes), candidate.sha256, 'baseline_repair_failure_digest');
    writeFileSync(join(evidenceDir, 'dependency-lock-rejected.json'), bytes, { flag: 'wx' });
  }
  writeFileSync(join(evidenceDir, 'dependency-repair-failure.json'), JSON.stringify({
    schemaVersion: failure.schemaVersion, stage: failure.stage,
    resolution: failure.resolution,
    candidate: { ...candidate, evidenceFile: bytes === null ? null : 'dependency-lock-rejected.json' },
    receipt: failure.receipt,
  }), { flag: 'wx' });
}

async function main() {
  const argument = (name: string) => {
    const value = process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
    assert.ok(value, 'Missing ' + name);
    return value;
  };
  const sourceRoot = argument('source-root');
  const evidenceDir = argument('evidence-dir');
  const fixtureBytes = readFileSync(argument('fixture-path'));
  assert.equal(digest(fixtureBytes), argument('fixture-sha'));
  const fixture = JSON.parse(fixtureBytes.toString());
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), fixture.sourceSha);
  assert.equal(fixture.files.length, 14);
  const beforeSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
  const beforeProductBoundary = baselineProductBoundary(sourceRoot, []);
  const { inputPaths } = metadataRepairInputLayout(sourceRoot);
  const beforeInputs = new Map<string, Buffer | null>(inputPaths.map((path: string) => [path,
    existsSync(join(sourceRoot, path)) ? readFileSync(join(sourceRoot, path)) : null]));
  // Retain selected bytes before the resolver starts, including on refusal.
  writeFileSync(join(evidenceDir, 'dependency-repair-inputs.json'), JSON.stringify({
    edition: repairedBaselineEdition, originalSourceSha: fixture.sourceSha,
    beforeSources, beforeProductBoundary, inputs: [...beforeInputs].map(([path, bytes]) => ({ path,
      sha256: bytes === null ? null : digest(bytes), base64: bytes?.toString('base64') ?? null })),
  }), { flag: 'wx' });
  const result = await resolveMetadataRepairLock({ repoRoot: sourceRoot }).catch((error: unknown) => {
    retainBaselineRepairFailure(evidenceDir, error);
    throw error;
  });
  assert.deepEqual([...result.snapshot.keys()], [...beforeInputs.keys()]);
  for (const [path, bytes] of result.snapshot as Map<string, Buffer | null>)
    assert.deepEqual(bytes, beforeInputs.get(path), 'baseline_repair_selected_input_changed:' + path);
  assertBaselineRepairInputs(sourceRoot, beforeInputs);
  assert.deepEqual(assertFrozenBaselineSources(sourceRoot, fixture.files), beforeSources);
  assert.ok('output' in result.receipt, 'baseline_repair_output_receipt_missing');
  const output = result.receipt.output;
  assert.ok(output && typeof output === 'object' && 'path' in output && 'sha256' in output,
    'baseline_repair_output_receipt_invalid');
  assert.equal(output.path, 'package-lock.json');
  assert.equal(result.receipt.cleanup.removed, true);
  const originalLock = beforeInputs.get('package-lock.json');
  assert.ok(originalLock);
  const repairedLock: Buffer = result.bytes;
  assert.equal(digest(repairedLock), output.sha256);
  const delta = baselineLockDelta(originalLock, repairedLock);
  assert.ok(delta.packages.length > 0, 'baseline_repair_missing_delta');
  writeFileSync(join(evidenceDir, 'dependency-lock-original.json'), originalLock, { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-lock-repaired.json'), repairedLock, { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-repair-delta.json'), JSON.stringify(delta), { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-repair-receipt.json'), JSON.stringify(result.receipt), { flag: 'wx' });
  // Only this exclusively owned disposable clone is changed. No publication or
  // original Git object is mutated, and the ordinary guarded installer follows.
  writeFileSync(join(sourceRoot, 'package-lock.json'), repairedLock);
  assertBaselineRepairInputs(sourceRoot, beforeInputs, { path: 'package-lock.json', bytes: repairedLock });
  const afterSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
  const afterProductBoundary = baselineProductBoundary(sourceRoot, ['package-lock.json']);
  writeFileSync(join(evidenceDir, 'dependency-edition.json'), JSON.stringify({
    edition: repairedBaselineEdition, originalSourceSha: fixture.sourceSha,
    originalDependenciesReconstructed: false, originalLockSha256: digest(originalLock),
    repairedLockSha256: digest(repairedLock), beforeSources, afterSources,
    beforeProductBoundary, afterProductBoundary,
    changedInputs: ['package-lock.json'], resolverReceipt: 'dependency-repair-receipt.json',
    selectedInputs: 'dependency-repair-inputs.json', fullDelta: 'dependency-repair-delta.json',
    acceptance: 'Unexecuted compatibility edition; independent review and actual client traces still required',
  }), { flag: 'wx' });
}

if (isCliEntry(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
