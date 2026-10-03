import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import type { SessionArchiveStore } from '../session-archive';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCanonicalClaudeLiveJsonl, findCanonicalNativeLiveJsonl, readCanonicalNativeArchive, readStableLiveJsonl } from './source';

describe('readStableLiveJsonl', () => {
  it('uses a fixed high-water and excludes the trailing partial record', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'port-source-')), 'session.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2');
    const source = await readStableLiveJsonl(path);
    expect(source.bytes.toString('utf8')).toBe('{"a":1}\n');
    expect(source.highWaterBytes).toBe(14);
    expect(source.completeBytes).toBe(8);
    expect(source.source).toBe('live-jsonl');
  });

  it('rejects before allocating beyond the configured cap', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'port-source-cap-')), 'session.jsonl');
    writeFileSync(path, '12345\n');
    await expect(readStableLiveJsonl(path, 5)).rejects.toThrow(/exceeds 5 byte cap/);
  });
});

describe('findCanonicalClaudeLiveJsonl', () => {
  it('selects exactly one regular project transcript and refuses ambiguity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-claude-'));
    mkdirSync(join(root, 'projects', 'cwd-a'), { recursive: true });
    writeFileSync(join(root, 'projects', 'cwd-a', 'sid.jsonl'), '{}\n');
    expect(await findCanonicalClaudeLiveJsonl(root, 'sid')).toBe(join(root, 'projects', 'cwd-a', 'sid.jsonl'));
    mkdirSync(join(root, 'projects', 'cwd-b'));
    writeFileSync(join(root, 'projects', 'cwd-b', 'sid.jsonl'), '{}\n');
    await expect(findCanonicalClaudeLiveJsonl(root, 'sid')).rejects.toThrow(/ambiguous/);
  });

  it('never traverses a symlinked project directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-claude-link-'));
    const foreign = mkdtempSync(join(tmpdir(), 'port-foreign-'));
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(foreign, 'sid.jsonl'), '{}\n');
    symlinkSync(foreign, join(root, 'projects', 'linked'));
    await expect(findCanonicalClaudeLiveJsonl(root, 'sid')).rejects.toThrow(/missing/);
  });
});

describe('exact native session-port sources', () => {
  it.each(['codex', 'omp'] as const)('validates the %s archive manifest and exact bytes before returning evidence', async (backend) => {
    const bytes = Buffer.from('{"native":"evidence"}\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relpath = backend === 'codex' ? 'sessions/2026/10/03/rollout-date-native-id.jsonl' : 'cwd/date_native-id.jsonl';
    const manifest = { relpath, sha256, bytes_raw: bytes.length };
    const readStamp = vi.fn(async () => ({ manifest: [manifest] }));
    const readFiles = vi.fn(async () => [{ ...manifest, codec: 'zstd', blob: zstdCompressSync(bytes) }]);
    const store = { readStamp, readFiles } as unknown as SessionArchiveStore;
    const acquired = await readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store);
    expect(acquired.bytes).toEqual(bytes);
    expect(acquired.sha256).toBe(sha256);
    expect(acquired.relpath).toBe(relpath);
    expect(readStamp).toHaveBeenCalledWith(backend, 'native-id');
    expect(readFiles).toHaveBeenCalledWith(backend, 'native-id');
    readFiles.mockClear();
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store, bytes.length - 1)).rejects.toThrow(/byte cap/);
    expect(readFiles).not.toHaveBeenCalled();
    readFiles.mockImplementation(async () => [{ ...manifest, sha256: 'b'.repeat(64), codec: 'zstd', blob: zstdCompressSync(bytes) }]);
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store)).rejects.toThrow(/metadata mismatch/);
    readStamp.mockImplementation(async () => ({ manifest: [manifest, { ...manifest, relpath: relpath.replace('date', 'other-date') }] }));
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store)).rejects.toThrow(/ambiguous/);
  });

  it.each(['codex', 'omp'] as const)('reads only the exact %s id and rejects a second matching transcript', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'port-native-'));
    const dir = join(root, ...(backend === 'codex' ? ['2026', '10', '03'] : ['cwd-a']));
    mkdirSync(dir, { recursive: true });
    const name = backend === 'codex' ? 'rollout-date-native-id.jsonl' : 'date_native-id.jsonl';
    const path = join(dir, name);
    writeFileSync(path, '{}\n');
    writeFileSync(join(dir, backend === 'codex' ? 'rollout-newest-another-id.jsonl' : 'newest_another-id.jsonl'), '{}\n');
    expect(await findCanonicalNativeLiveJsonl(root, backend, 'native-id')).toBe(path);
    const second = join(root, ...(backend === 'codex' ? ['2026', '10', '04'] : ['cwd-b']));
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, name), '{}\n');
    await expect(findCanonicalNativeLiveJsonl(root, backend, 'native-id')).rejects.toThrow(/ambiguous/);
  });

  it.each(['codex', 'omp'] as const)('rejects symlinked %s roots and transcript files', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'port-native-link-'));
    const foreign = mkdtempSync(join(tmpdir(), 'port-native-foreign-'));
    const name = backend === 'codex' ? 'rollout-date-native-id.jsonl' : 'date_native-id.jsonl';
    writeFileSync(join(foreign, name), '{}\n');
    symlinkSync(foreign, join(root, 'linked'));
    symlinkSync(join(foreign, name), join(root, name));
    await expect(findCanonicalNativeLiveJsonl(root, backend, 'native-id')).rejects.toThrow(/missing/);
    await expect(findCanonicalNativeLiveJsonl(join(root, 'linked'), backend, 'native-id')).rejects.toThrow(/missing/);
  });
});
