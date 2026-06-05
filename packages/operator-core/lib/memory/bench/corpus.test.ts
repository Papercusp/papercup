/**
 * Corpus snapshot + frozen fixture guards (memory-backend-benchmark
 * P-004). The fixture is the benchmark's ground truth — these tests
 * pin its invariants so a regen or hand-edit can't silently break the
 * gold set's key bindings.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCorpusFixture, snapshotClaudeCorpus } from './corpus';

describe('corpus.v1 fixture', () => {
  it('loads, is non-trivial, and every entry is well-formed', () => {
    const entries = loadCorpusFixture('v1');
    expect(entries.length).toBeGreaterThanOrEqual(110); // the real store at snapshot time
    const keys = new Set(entries.map((e) => e.key));
    expect(keys.size).toBe(entries.length); // unique keys
    for (const e of entries) {
      expect(e.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(e.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('is sorted by key (deterministic diffing)', () => {
    const entries = loadCorpusFixture('v1');
    const keys = entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});

describe('snapshotClaudeCorpus', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-snap-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads topic files, skips MEMORY.md/archive, never writes', async () => {
    fs.writeFileSync(
      path.join(dir, 'feedback_use_locks.md'),
      '---\nname: feedback_use_locks\ndescription: "Always lock before editing"\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\nPer-edit locking is automatic via the hook.\n',
    );
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory Index\n- stale pointer\n');
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.writeFileSync(path.join(dir, 'archive', 'old.md'), '---\nname: old\n---\nretired\n');

    const before = fs.readdirSync(dir).sort();
    const entries = await snapshotClaudeCorpus(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(before); // read-only

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'feedback_use_locks',
      kind: 'feedback',
      description: 'Always lock before editing',
    });
    expect(entries[0].text).toContain('automatic via the hook');
  });
});
