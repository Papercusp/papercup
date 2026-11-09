/** Test-only custody for the separately qualified D-004 dependency edition. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
// @ts-ignore -- reuse the maintained strict resolver, never a custom installer.
import { metadataRepairInputLayout, resolveMetadataRepairLock } from '../../../scripts/npm-install-safe.mjs';

export const repairedBaselineEdition = 'source-frozen-dependency-repaired-v1';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type FrozenSource = { path: string; sha256: string; content: string };

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
  const changedPaths = git(['diff', '--name-only', '--ignore-submodules=none', 'HEAD', '--'])
    .split('\n').filter(Boolean).sort();
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
  const result = await resolveMetadataRepairLock({ repoRoot: sourceRoot });
  assert.deepEqual([...result.snapshot.keys()], [...beforeInputs.keys()]);
  for (const [path, bytes] of result.snapshot as Map<string, Buffer | null>)
    assert.deepEqual(bytes, beforeInputs.get(path), 'baseline_repair_selected_input_changed:' + path);
  assertBaselineRepairInputs(sourceRoot, beforeInputs);
  assert.deepEqual(assertFrozenBaselineSources(sourceRoot, fixture.files), beforeSources);
  assert.equal(result.receipt.output.path, 'package-lock.json');
  assert.equal(result.receipt.cleanup.removed, true);
  const originalLock = beforeInputs.get('package-lock.json');
  assert.ok(originalLock);
  const repairedLock: Buffer = result.bytes;
  assert.equal(digest(repairedLock), result.receipt.output.sha256);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
