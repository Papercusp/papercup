import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readClaudeHygiene } from './claude-hygiene';

describe('readClaudeHygiene (memory-settings-page-refresh P-012)', () => {
  it('counts topic files and overflow index entries, excluding the indexes themselves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'claude-hygiene-'));
    await writeFile(path.join(dir, 'MEMORY.md'), '# index\n- [A](a.md) — hook\n');
    await writeFile(
      path.join(dir, 'MEMORY-overflow.md'),
      '# overflow\n- [B](b.md) — hook\n- [C](c.md) — hook\nprose line\n',
    );
    await writeFile(path.join(dir, 'a.md'), 'fact a');
    await writeFile(path.join(dir, 'b.md'), 'fact b');
    await writeFile(path.join(dir, '_private-note.md'), 'not a topic file');
    const h = await readClaudeHygiene(dir);
    expect(h).not.toBeNull();
    expect(h!.activeCount).toBe(2); // a.md + b.md — indexes and _-prefixed excluded
    expect(h!.overflowCount).toBe(2); // the two pointer lines
    expect(h!.indexBytes).toBeGreaterThan(0);
  });

  it('reports zero overflow when MEMORY-overflow.md is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'claude-hygiene-'));
    await writeFile(path.join(dir, 'a.md'), 'fact a');
    const h = await readClaudeHygiene(dir);
    expect(h).toEqual({ activeCount: 1, overflowCount: 0, indexBytes: 0 });
  });

  it('returns null for a box without a Claude store', async () => {
    expect(await readClaudeHygiene('/nonexistent/claude/memory')).toBeNull();
  });
});
