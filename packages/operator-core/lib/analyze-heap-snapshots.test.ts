import { spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { summarizeHeapSnapshot, summarizeHeapSnapshotStream } from '../../../scripts/analyze-heap-snapshots.mjs';

describe('private V8 heap snapshot census', () => {
  it('detects a real surviving large array without exporting private string payloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p011-heap-census-'));
    try {
      const result = spawnSync(process.execPath, ['-e', String.raw`
        const { writeHeapSnapshot } = require('node:v8');
        const path = require('node:path');
        writeHeapSnapshot(path.join(process.env.P011_HEAP_DIR, 'before.heapsnapshot'));
        class P011LargeFixture { constructor() { this.values = Array(2000000).fill(17);
          this.payload = 'never-emit-me' + 'sensitive'.repeat(100000); } }
        globalThis.fixture = new P011LargeFixture();
        writeHeapSnapshot(path.join(process.env.P011_HEAP_DIR, 'after.heapsnapshot'));
        if (globalThis.fixture.values.length !== 2000000) process.exit(2);
      `], { env: { ...process.env, P011_HEAP_DIR: directory }, encoding: 'utf8', timeout: 60000 });
      expect(result.status, result.stderr).toBe(0);
      const before = summarizeHeapSnapshot(JSON.parse(readFileSync(join(directory, 'before.heapsnapshot'), 'utf8')));
      const after = summarizeHeapSnapshot(JSON.parse(readFileSync(join(directory, 'after.heapsnapshot'), 'utf8')));
      const arrayBytes = (report: typeof after) => report.types.find((row: any) => row.type === 'array')!.selfSizeBytes;
      expect(arrayBytes(after) - arrayBytes(before)).toBeGreaterThan(15_000_000);
      expect(after.topClasses.some((row: any) => row.class === '(object elements)' && row.selfSizeBytes > 15_000_000)).toBe(true);
      expect(after.types.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(after.nodeCount);
      expect(after.types.reduce((sum: number, row: any) => sum + row.selfSizeBytes, 0)).toBe(after.totalSelfSizeBytes);
      expect(JSON.stringify(after)).not.toMatch(/never-emit-me|sensitive/);
      expect(after.definition).toContain('not retained/exclusive');
      const streamed = await summarizeHeapSnapshotStream(createReadStream(join(directory, 'after.heapsnapshot')));
      expect(streamed.census).toEqual(after);
      const raw = readFileSync(join(directory, 'after.heapsnapshot'));
      expect(streamed.bytes).toBe(raw.length);
      expect(streamed.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 75000);

  it('rejects partial metadata and invalid node values instead of reporting a complete census', () => {
    const snapshot = { snapshot: { node_count: 1, meta: {
      node_fields: ['type', 'name', 'self_size'], node_types: [['string']] } },
      nodes: [0, 0, 12], strings: ['never-emit-me'] };
    expect(summarizeHeapSnapshot(snapshot).topClasses[0].class).toBe('(string)');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [] })).toThrow('Incomplete');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [3, 0, 12] })).toThrow('values');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [0, 0, -1] })).toThrow('values');
    expect(() => summarizeHeapSnapshot(snapshot, { top: 0 })).toThrow('limit');
  });

  it('consumes chunked oversized strings without packing payloads and rejects incomplete streams', async () => {
    const prefix = '{"snapshot":{"node_count":1,"meta":{"node_fields":["type","name","self_size"],"node_types":[["string"]]}},"nodes":[0,0,12],"edges":[],"strings":["';
    const suffix = '"]}';
    const payload = 'never-emit-me'.repeat(60000);
    const input = Readable.from([prefix, ...Array(16).fill(payload), suffix]);
    const result = await summarizeHeapSnapshotStream(input);
    expect(result.bytes).toBe(Buffer.byteLength(prefix + suffix) + 16 * Buffer.byteLength(payload));
    expect(result.census.topClasses).toEqual([{ type: 'string', class: '(string)', count: 1, selfSizeBytes: 12 }]);
    expect(JSON.stringify(result)).not.toContain('never-emit-me');
    await expect(summarizeHeapSnapshotStream(Readable.from([prefix]))).rejects.toThrow();
  });

  it('retains every class before a multi-snapshot CLI ranking instead of truncating each input', async () => {
    const snapshot = { snapshot: { node_count: 150, meta: {
      node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
      nodes: Array.from({ length: 150 }, (_, i) => [0, i, i + 1]).flat(),
      strings: Array.from({ length: 150 }, (_, i) => 'FixtureClass' + i) };
    const result = await summarizeHeapSnapshotStream(Readable.from([JSON.stringify(snapshot)]), { top: 0 });
    expect(result.census.topClasses).toHaveLength(150);
    expect(result.census.topClasses.reduce((sum: number, row: any) => sum + row.selfSizeBytes, 0))
      .toBe(result.census.totalSelfSizeBytes);
  });
});
