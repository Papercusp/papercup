import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBoxIdentityPaths, findIdentityLiterals, resolveIdentityLiterals } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { assertBaselineRepairInputs, assertFrozenBaselineSources, baselineLockDelta } from '../test/task-artifacts-baseline-repair';

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
      const snapshot = new Map([['package.json', manifest], ['package-lock.json', lock], ['.npmrc', null]]);
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
