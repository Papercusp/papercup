import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOversizedDirtyFiles, type RunGit } from './run-git-sync';

// G22 (test-coverage-gap): existing oversized tests use sizes clearly over the
// limit (e.g. 2048 vs 1024). None pin the EXACT boundary. The comparison is
// strict `>` (run-git-sync.ts: `st.size > maxBytes`), so a file of exactly
// maxBytes must be INCLUDED in the commit — a `>`→`>=` slip would needlessly
// exclude files at the limit. This test exercises maxBytes-1 / maxBytes / maxBytes+1.

const MAX = 64;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oversize-boundary-'));
  writeFileSync(join(dir, 'under'), Buffer.alloc(MAX - 1)); // < MAX → included
  writeFileSync(join(dir, 'at-limit'), Buffer.alloc(MAX)); //   = MAX → included (NOT > MAX)
  writeFileSync(join(dir, 'over'), Buffer.alloc(MAX + 1)); //   > MAX → excluded
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Mock git status: report all three files as untracked (porcelain -z -uall).
const runGit: RunGit = async (args) => {
  if (args[0] === 'status') {
    return { code: 0, stdout: '?? under\0?? at-limit\0?? over\0', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};

describe('findOversizedDirtyFiles — exact maxBytes boundary (strict >, not >=)', () => {
  it('excludes only files strictly OVER maxBytes; a file AT the limit is committed', async () => {
    const oversized = await findOversizedDirtyFiles(runGit, dir, MAX);
    const paths = oversized.map((f) => f.path);
    expect(paths).toContain('over'); // MAX+1 → excluded
    expect(paths).not.toContain('at-limit'); // exactly MAX → INCLUDED
    expect(paths).not.toContain('under'); // MAX-1 → included
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.sizeBytes).toBe(MAX + 1);
  });

  it('with maxBytes one smaller, the at-limit file flips to excluded (boundary is load-bearing)', async () => {
    const oversized = await findOversizedDirtyFiles(runGit, dir, MAX - 1);
    const paths = oversized.map((f) => f.path);
    expect(paths).toContain('over');
    expect(paths).toContain('at-limit'); // now MAX > MAX-1 → excluded
    expect(paths).not.toContain('under'); // MAX-1 == limit → still included
  });
});
