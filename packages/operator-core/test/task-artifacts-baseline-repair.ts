/** Test-only custody for the separately qualified D-004 dependency edition. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, writeFileSync, type BigIntStats } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCliEntry } from '../lib/util/cli-entry';
import type { NativeProofInput } from '../lib/testing-run-store';
// @ts-ignore -- reuse the maintained strict resolver, never a custom installer.
import { metadataRepairInputLayout, resolveMetadataRepairLock } from '../../../scripts/npm-install-safe.mjs';
import { auditTree } from '../../../apps/operator/bin/release/dependency-lock-tree-audit.mjs';

export const repairedBaselineEdition = 'source-frozen-dependency-repaired-v1';
export const baselineRepairFailureArtifacts = [
  'phases/prepare/dependency-lock-rejected.json',
  'phases/prepare/dependency-repair-failure.json',
] as const;
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type FrozenSource = { path: string; sha256: string; content: string };

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
  const census = () => new Promise<string>((done, reject) => {
    const child = spawn('bash', ['-euo', 'pipefail', '-c',
      'source "$1"; dependency_generation_enumerate_node_modules "$2"', 'baseline-installed-tree',
      join(helperRoot, 'apps/operator/bin/release/dependency-generation.sh'), root],
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
  const { inputPaths } = metadataRepairInputLayout(root);
  const lockfiles = inputPaths.filter((path: string) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path)
    && existsSync(join(root, path)));
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
  const manifest = { schemaVersion: 1, trees, audit,
    entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...manifest, sha256: digest(JSON.stringify(manifest)) };
}

export async function assertBaselineInstalledTree(root: string,
  expected: Awaited<ReturnType<typeof captureBaselineInstalledTree>>, helperRoot?: string) {
  const actual = await captureBaselineInstalledTree(root, helperRoot);
  assert.deepEqual(actual, expected, 'baseline_installed_tree_changed');
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

/** Keep complete changed package records, including removed entries and integrity. */
export function baselineLockDelta(beforeBytes: Buffer, afterBytes: Buffer) {
  const before = JSON.parse(beforeBytes.toString());
  const after = JSON.parse(afterBytes.toString());
  assert.ok(before.packages && after.packages, 'baseline_repair_lock_graph');
  const keys = [...new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])].sort();
  const packages = keys.filter(path => !isDeepStrictEqual(before.packages[path], after.packages[path]))
    .map(path => ({ path, before: before.packages[path] ?? null, after: after.packages[path] ?? null }));
  const { packages: _beforePackages, ...metadataBefore } = before;
  const { packages: _afterPackages, ...metadataAfter } = after;
  return { metadataBefore, metadataAfter, packages };
}

/** Match the full selected population (including absence) and deterministic
 * repair plan before ci/build. Observed outputs cannot mint another edition. */
export function assertBaselinePlannedRepair(input: Pick<NativeProofInput, 'selectedInputs' | 'plannedRepair'>,
  snapshot: Map<string, Buffer | null>, repaired: Buffer, delta: Buffer) {
  const selected = Object.fromEntries([...snapshot].map(([path, bytes]) =>
    [path, bytes === null ? null : digest(bytes)]));
  assert.deepEqual(selected, input.selectedInputs, 'baseline_prelaunch_selected_inputs_changed');
  const graph = JSON.parse(repaired.toString()).packages;
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph), 'baseline_prelaunch_graph_missing');
  const candidateGraph = Buffer.from(JSON.stringify(graph));
  assert.deepEqual({ lockSha256: digest(repaired), packageDeltaSha256: digest(delta),
    candidateGraphSha256: digest(candidateGraph) }, input.plannedRepair, 'baseline_prelaunch_repair_changed');
  return candidateGraph;
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
