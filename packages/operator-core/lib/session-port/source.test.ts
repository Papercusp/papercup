import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCanonicalClaudeLiveJsonl, readStableLiveJsonl } from './source';

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
