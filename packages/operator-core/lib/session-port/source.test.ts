import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStableLiveJsonl } from './source';

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
