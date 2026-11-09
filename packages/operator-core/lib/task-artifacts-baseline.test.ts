import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Captured from the running pre-feature build before product edits. This edition
// is deliberately independent of candidate imports and cannot be re-generated
// by changing a candidate flag. Keep old editions when reviewing a replacement.
const FIXTURE_SHA = '4b9fe3800168b16a3e842d04de33faa906779dcf6254b26c0fb59f6044434a5f';
const SOURCE_SHA = '729986dd35171f1e0cb11bd1505295917f2d946f';
const bytes = readFileSync(new URL('../test/fixtures/task-artifacts/baseline-729986dd35.json', import.meta.url));
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function readFrozenBaseline(raw: Uint8Array) {
  if (sha256(raw) !== FIXTURE_SHA) throw new Error('baseline_fixture_changed');
  return JSON.parse(Buffer.from(raw).toString('utf8')) as {
    sourceSha: string;
    traceStatus: string;
    files: Array<{ path: string; bytes: number; sha256: string; content: string }>;
    loadedRuntime: { manifestOriginalBytes: string; manifestFileSha256: string; bundleSha256: string };
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

  it('binds the original loaded manifest and bundle identity to that source', () => {
    const { loadedRuntime } = readFrozenBaseline(bytes);
    expect(sha256(loadedRuntime.manifestOriginalBytes)).toBe(loadedRuntime.manifestFileSha256);
    const manifest = JSON.parse(loadedRuntime.manifestOriginalBytes);
    expect(manifest.headSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.sourceSha).toBe(SOURCE_SHA);
    expect(manifest.artifact.bundleSha256).toBe(loadedRuntime.bundleSha256);
    expect(loadedRuntime.bundleSha256).toBe('5ab328c626de5c96cd1571f78f618de20b0772288d66e4e8301bb35107de5e11');
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
