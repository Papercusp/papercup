import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHarness } from '@papercusp/verification-harness';
import { findBoxIdentityPaths, findIdentityLiterals, resolveIdentityLiterals } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { assertBaselineInstalledTree, captureBaselineInstalledTree,
  assertBaselinePlannedRepair, assertBaselineRepairInputs, assertFrozenBaselineSources, baselineLockDelta,
  baselineProductBoundary, baselineRepairFailureArtifacts,
  retainBaselineRepairFailure } from '../test/task-artifacts-baseline-repair';

// Original source bytes captured before product edits, independent of candidate
// imports. Runtime paths stay in the immutable PG capture, outside release source.
// This portable fixture is a distinct edition; its manifest is only a projection.
const CAPTURE_SHA = '4b9fe3800168b16a3e842d04de33faa906779dcf6254b26c0fb59f6044434a5f';
const FIXTURE_SHA = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
const SOURCE_SHA = '729986dd35171f1e0cb11bd1505295917f2d946f';
const bytes = readFileSync(new URL('../test/fixtures/task-artifacts/baseline-729986dd35.json', import.meta.url));
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function readFrozenBaseline(raw: Uint8Array) {
  if (sha256(raw) !== FIXTURE_SHA) throw new Error('baseline_fixture_changed');
  return JSON.parse(Buffer.from(raw).toString('utf8')) as {
    sourceSha: string;
    traceStatus: string;
    files: Array<{ path: string; bytes: number; sha256: string; content: string }>;
    originalCapture: { harness: string; relPath: string; sha256: string; bytes: number };
    loadedRuntime: { manifestFileSha256: string; bundleSha256: string;
      manifestProjection: { headSha: string; artifact: { sourceSha: string; bundleSha256: string } } };
  };
}

describe('managed artifact pre-feature baseline custody', () => {
  it('refuses the actual fresh native fixture before runtime creation when its serialized handoff is missing', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      join(root, 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts')], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env,
        NODE_OPTIONS: '', PAPERCUSP_TEST_RUNS_DB_URL: '',
        TASK_ARTIFACT_BASELINE_EVIDENCE_DIR: '/must-not-create-native-runtime',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Original durable native child handoff required before private runtime creation');
    expect(result.stderr).not.toContain('Vitest failed to access its internal state');
    expect(result.stdout).not.toContain('TASK_ARTIFACT_CLIENT_BASELINE_RECEIPT');
  }, 45_000);

  it('preserves original adapter bytes under the independently captured edition digest', () => {
    const baseline = readFrozenBaseline(bytes);
    expect(baseline.sourceSha).toBe(SOURCE_SHA);
    expect(baseline.files).toHaveLength(14);
    expect(new Set(baseline.files.map(file => file.path)).size).toBe(baseline.files.length);
    for (const file of baseline.files) {
      expect(Buffer.byteLength(file.content), file.path).toBe(file.bytes);
      expect(sha256(file.content), file.path).toBe(file.sha256);
    }
    // A source fixture is not a completed paired trace or adapter verdict.
    expect(baseline.traceStatus).toBe('not-yet-captured');
  });

  it('retains the immutable original capture reference and projected runtime identity', () => {
    const { loadedRuntime, originalCapture } = readFrozenBaseline(bytes);
    expect(originalCapture).toEqual({ harness: 'papercusp',
      relPath: `immutable/sha256/${CAPTURE_SHA}.json`, sha256: CAPTURE_SHA, bytes: 409696 });
    expect(loadedRuntime.manifestFileSha256).toBe('8e26f7e48d9230f095f3cd1c33945567abc66bb5dab95611ce25fe5d3520a49a');
    const manifest = loadedRuntime.manifestProjection;
    expect(manifest.headSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.sourceSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.bundleSha256).toBe(loadedRuntime.bundleSha256);
    expect(loadedRuntime.bundleSha256).toBe('5ab328c626de5c96cd1571f78f618de20b0772288d66e4e8301bb35107de5e11');
  });

  it('keeps source fixtures free of machine identity without exempting historical captures', () => {
    const source = bytes.toString('utf8');
    expect(findBoxIdentityPaths(source)).toEqual([]);
    expect(findIdentityLiterals(source, Object.entries(resolveIdentityLiterals()))).toEqual([]);
    expect(source).not.toContain('manifestOriginalBytes');
  });

  it('rejects a replacement even when its internal file digest was updated', () => {
    const replacement = structuredClone(readFrozenBaseline(bytes));
    replacement.files[0].content += '\n// candidate replacement\n';
    replacement.files[0].bytes = Buffer.byteLength(replacement.files[0].content);
    replacement.files[0].sha256 = sha256(replacement.files[0].content);
    expect(() => readFrozenBaseline(Buffer.from(JSON.stringify(replacement))))
      .toThrow('baseline_fixture_changed');
  });
});

describe('separately qualified baseline dependency repair custody', () => {
  async function installedFixture(run: (root: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-installed-'));
    try {
      mkdirSync(join(root, 'node_modules', 'runtime'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"original","version":"1.0.0"}');
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'original', version: '1.0.0' },
        'node_modules/runtime': { version: '1.0.0' },
      } }));
      writeFileSync(join(root, 'node_modules/runtime/package.json'), '{"name":"runtime","version":"1.0.0"}');
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'original native bytes');
      await run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('rejects byte, mode, hidden-file, population and link-target substitutions in the actual installed tree', async () => {
    await installedFixture(async root => {
      mkdirSync(join(root, 'node_modules/.bin'));
      symlinkSync('../runtime/native.node', join(root, 'node_modules/.bin/runtime'));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'node_modules/runtime/native.node',
        kind: 'file', sha256: sha256('original native bytes') }));
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'node_modules/.bin/runtime',
        kind: 'link', target: '../runtime/native.node', resolved: 'node_modules/runtime/native.node' }));
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'tampered native bytes');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      writeFileSync(join(root, 'node_modules/runtime/native.node'), 'original native bytes');
      await expect(assertBaselineInstalledTree(root, original)).resolves.toBeUndefined();
      chmodSync(join(root, 'node_modules/runtime/native.node'), 0o755);
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      chmodSync(join(root, 'node_modules/runtime/native.node'), 0o644);
      writeFileSync(join(root, 'node_modules/.injected'), 'hidden');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/.injected'));
      rmSync(join(root, 'node_modules/.bin/runtime'));
      symlinkSync('../runtime/package.json', join(root, 'node_modules/.bin/runtime'));
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/.bin/runtime'));
      symlinkSync('/etc/passwd', join(root, 'node_modules/.bin/runtime'));
      await expect(captureBaselineInstalledTree(root)).rejects.toThrow('baseline_installed_path');
    });
  }, 60_000);

  it('hashes workspace link targets and retains the strict lock and native runtime audit', async () => {
    await installedFixture(async root => {
      mkdirSync(join(root, 'packages/local'), { recursive: true });
      writeFileSync(join(root, 'packages/local/package.json'), '{"name":"local","version":"1.0.0"}');
      writeFileSync(join(root, 'packages/local/index.js'), 'original linked bytes');
      symlinkSync('../packages/local', join(root, 'node_modules/local'));
      const lockPath = join(root, 'package-lock.json'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.packages['node_modules/local'] = { link: true, resolved: 'packages/local' };
      lock.packages['packages/local'] = { version: '1.0.0' };
      writeFileSync(lockPath, JSON.stringify(lock));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries).toContainEqual(expect.objectContaining({ path: 'packages/local/index.js',
        sha256: sha256('original linked bytes') }));
      writeFileSync(join(root, 'packages/local/index.js'), 'tampered linked bytes');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
      rmSync(join(root, 'node_modules/runtime/package.json'));
      await expect(captureBaselineInstalledTree(root)).rejects.toThrow('baseline_installed_lock_audit');
    });
  }, 60_000);

  it.each([255, 256, 257, 1025])('keeps every installed file across a %i-entry census and repeated reads', async count => {
    await installedFixture(async root => {
      // Reverse creation order must not change the complete, sorted receipt.
      for (let n = count - 1; n >= 0; n--)
        writeFileSync(join(root, 'node_modules/runtime/file-' + n.toString().padStart(5, '0')), String(n));
      const original = await captureBaselineInstalledTree(root);
      expect(original.entries.filter(entry => entry.path.includes('/file-'))).toHaveLength(count);
      await expect(captureBaselineInstalledTree(root)).resolves.toEqual(original);
      const decisive = 'node_modules/runtime/file-' + (count - 1).toString().padStart(5, '0');
      expect(original.entries).toContainEqual(expect.objectContaining({ path: decisive, sha256: sha256(String(count - 1)) }));
      writeFileSync(join(root, decisive), 'changed after the boundary');
      await expect(assertBaselineInstalledTree(root, original)).rejects.toThrow('baseline_installed_tree_changed');
    });
  }, 60_000);

  it('binds the complete prelaunch input population and actual repair bytes before install', () => {
    const snapshot = new Map<string, Buffer | null>([['package.json', Buffer.from('{"name":"original"}')],
      ['package-lock.json', Buffer.from('original lock')], ['.npmrc', null]]);
    const graph = { '': { name: 'original' }, 'node_modules/runtime': { version: '1.0.0' } };
    const repaired = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: graph }));
    const delta = Buffer.from(JSON.stringify({ packages: [{ path: 'node_modules/runtime', before: null,
      after: graph['node_modules/runtime'] }] }));
    const input = { selectedInputs: Object.fromEntries([...snapshot].map(([path, bytes]) =>
      [path, bytes === null ? null : sha256(bytes)])), plannedRepair: {
      lockSha256: sha256(repaired), packageDeltaSha256: sha256(delta),
      candidateGraphSha256: sha256(JSON.stringify(graph)),
    } };
    expect(assertBaselinePlannedRepair(input, new Map([...snapshot].reverse()), repaired, delta))
      .toEqual(Buffer.from(JSON.stringify(graph)));
    const missing = new Map(snapshot); missing.delete('.npmrc');
    const introduced = new Map(snapshot); introduced.set('npm-shrinkwrap.json', null);
    const changed = new Map(snapshot); changed.set('.npmrc', Buffer.from('legacy-peer-deps=true'));
    for (const invalid of [missing, introduced, changed])
      expect(() => assertBaselinePlannedRepair(input, invalid, repaired, delta))
        .toThrow('baseline_prelaunch_selected_inputs_changed');
    for (const field of ['lockSha256', 'packageDeltaSha256', 'candidateGraphSha256'] as const) {
      const replaced = structuredClone(input); replaced.plannedRepair[field] = '0'.repeat(64);
      expect(() => assertBaselinePlannedRepair(replaced, snapshot, repaired, delta), field)
        .toThrow('baseline_prelaunch_repair_changed');
    }
    expect(() => assertBaselinePlannedRepair(input, snapshot, Buffer.from(repaired + '\n'), delta))
      .toThrow('baseline_prelaunch_repair_changed');
    expect(() => assertBaselinePlannedRepair(input, snapshot, repaired, Buffer.from(delta + '\n')))
      .toThrow('baseline_prelaunch_repair_changed');
  });

  it.each([true, false])('keeps failure diagnostics in the real retained packet after cleanup (candidate bytes: %s)', async hasBytes => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-packet-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(root, 'canonical'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'mutex'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(root, 'pins'));
    try {
      const bytes = hasBytes ? Buffer.from('{"rejected":true}') : null;
      const receipt = { cleanup: { removed: true } };
      const candidate = { path: 'package-lock.json', bytes, sha256: bytes && sha256(bytes),
        size: bytes?.length ?? null, omission: hasBytes ? null : 'absent' };
      const result = await runHarness({
        contract: { name: 'task-artifacts-repair-failure', phases: [
          { id: 'prepare' }, { id: 'execute', dependsOn: ['prepare'] }, { id: 'teardown' },
        ] }, evidenceRoot: join(root, 'runs'), retainedArtifacts: baselineRepairFailureArtifacts,
        guardRails: [], runPhase: async phase => {
          if (phase.phase === 'prepare') {
            retainBaselineRepairFailure(phase.evidenceDir, Object.assign(new Error('rejected'), {
              metadataRepairFailure: { schemaVersion: 1, stage: 'validate-graph', candidate,
                resolution: { exitCode: 0 }, receipt },
            }));
            return { ok: false, reasonCode: 'metadata-repair-graph-local-target' };
          }
          expect(phase.phase).toBe('teardown');
          return { ok: true };
        },
      });
      expect(result.verdict).toBe('fail');
      expect(result.firstFailure?.reasonCode).toBe('metadata-repair-graph-local-target');
      // Exercise finalization's actual retained copy, after disposable evidence
      // is gone, using the same selectors as the full client baseline.
      rmSync(result.evidenceDir, { recursive: true, force: true });
      const retained = join(root, 'runs', 'retained', result.runId);
      const manifest = JSON.parse(readFileSync(join(retained, 'retained-artifacts.json'), 'utf8'));
      expect(manifest.selectors).toEqual(baselineRepairFailureArtifacts);
      const evidencePath = baselineRepairFailureArtifacts[1];
      const evidenceBytes = readFileSync(join(retained, evidencePath));
      expect(JSON.parse(evidenceBytes.toString())).toMatchObject({ stage: 'validate-graph', receipt,
        candidate: { omission: candidate.omission,
          evidenceFile: hasBytes ? 'dependency-lock-rejected.json' : null } });
      expect(manifest.artifacts).toContainEqual(expect.objectContaining({ path: evidencePath,
        sha256: sha256(evidenceBytes), bytes: evidenceBytes.length }));
      if (bytes) expect(readFileSync(join(retained, baselineRepairFailureArtifacts[0]))).toEqual(bytes);
      else expect(() => readFileSync(join(retained, baselineRepairFailureArtifacts[0]))).toThrow();
      expect(() => readFileSync(join(retained, 'phases/prepare/dependency-edition.json'))).toThrow();
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it('retains rejected bytes and cleanup receipt without treating them as a repaired edition', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-rejection-'));
    try {
      const bytes = Buffer.from('{"rejected":true}');
      const candidate = { path: 'package-lock.json', bytes, sha256: sha256(bytes),
        size: bytes.length, omission: null };
      const receipt = { cleanup: { removed: true } };
      const resolution = { exitCode: 0 };
      const error = Object.assign(new Error('metadata-repair-graph-local-target'), {
        metadataRepairFailure: { schemaVersion: 1, stage: 'validate-graph', candidate, resolution, receipt },
      });
      retainBaselineRepairFailure(root, error);
      expect(readFileSync(join(root, 'dependency-lock-rejected.json'))).toEqual(bytes);
      const evidence = JSON.parse(readFileSync(join(root, 'dependency-repair-failure.json'), 'utf8'));
      expect(evidence).toEqual({ schemaVersion: 1, stage: 'validate-graph', receipt, resolution,
        candidate: { path: candidate.path, sha256: candidate.sha256, size: bytes.length,
          omission: null, evidenceFile: 'dependency-lock-rejected.json' } });
      expect(() => readFileSync(join(root, 'dependency-edition.json'))).toThrow();
      expect(() => retainBaselineRepairFailure(root, error)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a source replacement even when dependency metadata is otherwise valid', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-freeze-'));
    try {
      const content = 'original source\n';
      const files = [{ path: 'adapter.ts', content, sha256: sha256(content) }];
      writeFileSync(join(root, 'adapter.ts'), content);
      expect(assertFrozenBaselineSources(root, files)).toEqual([{ path: 'adapter.ts', sha256: sha256(content) }]);
      writeFileSync(join(root, 'adapter.ts'), 'candidate source\n');
      expect(() => assertFrozenBaselineSources(root, files)).toThrow('baseline_source_changed:adapter.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('permits only the selected repaired lock and rejects changed or newly introduced input', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-inputs-'));
    try {
      const manifest = Buffer.from('{"name":"selected"}');
      const lock = Buffer.from('original lock');
      const repaired = Buffer.from('repaired lock');
      const snapshot = new Map([['package.json', manifest], ['package-lock.json', lock],
        ['npm-shrinkwrap.json', null], ['.npmrc', null]]);
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'package-lock.json'), repaired);
      const output = { path: 'package-lock.json', bytes: repaired };
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).not.toThrow();
      writeFileSync(join(root, '.npmrc'), 'legacy-peer-deps=true');
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).toThrow('baseline_repair_input_changed:.npmrc');
      rmSync(join(root, '.npmrc'));
      writeFileSync(join(root, 'package.json'), '{"name":"different"}');
      expect(() => assertBaselineRepairInputs(root, snapshot, output)).toThrow('baseline_repair_input_changed:package.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a new workspace selected after installation or build', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-population-'));
    try {
      const manifest = Buffer.from('{"name":"selected","workspaces":["packages/*"]}');
      const lock = Buffer.from('{"lockfileVersion":3,"packages":{}}');
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'package-lock.json'), lock);
      const snapshot = new Map([['package.json', manifest], ['package-lock.json', lock],
        ['npm-shrinkwrap.json', null], ['.npmrc', null]]);
      expect(() => assertBaselineRepairInputs(root, snapshot)).not.toThrow();
      mkdirSync(join(root, 'packages', 'introduced'), { recursive: true });
      writeFileSync(join(root, 'packages', 'introduced', 'package.json'), '{"name":"introduced"}');
      expect(() => assertBaselineRepairInputs(root, snapshot)).toThrow('baseline_repair_input_population_changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects untracked source while allowing ignored build caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-baseline-tree-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(root, 'adapter.ts'), 'export const original = true;');
      writeFileSync(join(root, '.gitignore'), 'cache/\n');
      git('add', '.');
      git('-c', 'user.name=Baseline fixture', '-c', 'user.email=baseline@example.invalid',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'frozen test source');
      mkdirSync(join(root, 'cache'));
      writeFileSync(join(root, 'cache', 'build.bin'), 'build cache');
      expect(baselineProductBoundary(root, []).changedPaths).toEqual([]);
      writeFileSync(join(root, 'introduced.ts'), 'export const replacement = true;');
      expect(() => baselineProductBoundary(root, [])).toThrow('baseline_product_tree_changed');
      expect(baselineProductBoundary(root, ['introduced.ts']).changedPaths).toEqual(['introduced.ts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains complete changed and removed package metadata rather than version-only deltas', () => {
    const old = { lockfileVersion: 3, packages: { 'node_modules/a': { version: '1', integrity: 'old' },
      'node_modules/removed': { version: '2', optional: true } } };
    const next = { lockfileVersion: 3, packages: { 'node_modules/a': { version: '1', integrity: 'different',
      dependencies: { b: '^2' } } } };
    const delta = baselineLockDelta(Buffer.from(JSON.stringify(old)), Buffer.from(JSON.stringify(next)));
    expect(delta.packages).toEqual([
      { path: 'node_modules/a', before: old.packages['node_modules/a'], after: next.packages['node_modules/a'] },
      { path: 'node_modules/removed', before: old.packages['node_modules/removed'], after: null },
    ]);
    expect(delta.metadataBefore).toEqual({ lockfileVersion: 3 });
    expect(delta.metadataAfter).toEqual({ lockfileVersion: 3 });
  });
});
