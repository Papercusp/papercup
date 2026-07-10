/**
 * jsonlAtDepth descend-filter contract (session-db-archive-retire-dirs
 * P-005). The su-codex-homes root is FAT (~20 subdirs per home; historically
 * 282k dirs total) — the descend filter must keep the walk pinned to
 * <home>/sessions/YYYY/MM/DD and never enumerate the rest (the 2026-07-05
 * sweep-hang class).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonlAtDepth } from './session-ingest';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('jsonlAtDepth', () => {
  it('descend filter prunes non-sessions subtrees of per-session codex homes', async () => {
    root = await mkdtemp(join(tmpdir(), 'walker-'));
    // the real payload
    await mkdir(join(root, 'session-1', 'sessions', '2026', '07', '10'), { recursive: true });
    await writeFile(join(root, 'session-1', 'sessions', '2026', '07', '10', 'rollout-a.jsonl'), 'a\n');
    await mkdir(join(root, 'session-2', 'sessions', '2026', '07', '09'), { recursive: true });
    await writeFile(join(root, 'session-2', 'sessions', '2026', '07', '09', 'rollout-b.jsonl'), 'b\n');
    // noise at the same depth under a NON-sessions level-2 dir
    await mkdir(join(root, 'session-1', 'chrome', 'x', 'y', 'z'), { recursive: true });
    await writeFile(join(root, 'session-1', 'chrome', 'x', 'y', 'z', 'noise.jsonl'), 'n\n');

    const unfiltered = await jsonlAtDepth(root, 5);
    expect(unfiltered.length).toBe(3); // proves the noise IS reachable without the filter

    const filtered = await jsonlAtDepth(root, 5, (name, level) => (level === 2 ? name === 'sessions' : true));
    expect(filtered.map((p) => p.split('/').pop()).sort()).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl']);
  });

  it('missing root yields empty, never throws', async () => {
    expect(await jsonlAtDepth('/nonexistent-root-xyz', 3)).toEqual([]);
  });
});
