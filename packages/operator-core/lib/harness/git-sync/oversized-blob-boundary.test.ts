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

// WI-3595: a real repro (throwaway git repo, `git status --porcelain -z -uall`
// vs `git check-ignore`) confirmed a gitignored oversized file is ALREADY
// excluded — plain `git status` (without `--ignored`) never lists it, so
// findOversizedDirtyFiles never sees it to begin with; there is no separate
// fs-walk fallback that could rediscover it independently of git status. The
// bug this item reported does not reproduce against the current
// implementation. This test pins the two facts that make that true, so a
// future edit can't silently reintroduce it: (1) the exact args passed to
// `git status` never include `--ignored`, and (2) a gitignored oversized file
// that (correctly) never appears in `git status`'s output is never surfaced
// as oversized — the scan has no independent fs-walk path around `git status`.
describe('findOversizedDirtyFiles — WI-3595 gitignored paths never surface as oversized', () => {
  it('invokes `git status` WITHOUT --ignored (so gitignored paths are never candidates)', async () => {
    const calls: string[][] = [];
    const spyRunGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await findOversizedDirtyFiles(spyRunGit, dir, MAX);
    const statusCall = calls.find((a) => a[0] === 'status');
    expect(statusCall).toBeDefined();
    expect(statusCall).not.toContain('--ignored');
  });

  it('a gitignored oversized file (absent from `git status --porcelain` output, matching real git behavior) is never reported oversized — no fs-walk fallback rediscovers it', async () => {
    // `.wi3388-cargo-target/big.bin` mirrors the exact WI-3595 repro path/shape:
    // present on disk, oversized, but git-ignored — so a real `git status`
    // never lists it. This mock reproduces that real behavior (empty status)
    // rather than asserting anything about our own parsing of a fabricated line.
    const bigFileDir = join(dir, '.wi3388-cargo-target');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(bigFileDir, { recursive: true });
    writeFileSync(join(bigFileDir, 'big.bin'), Buffer.alloc(MAX + 1));
    try {
      const ignoredStatusRunGit: RunGit = async (args) => {
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }; // real git: ignored path never listed
        return { code: 0, stdout: '', stderr: '' };
      };
      const oversized = await findOversizedDirtyFiles(ignoredStatusRunGit, dir, MAX);
      expect(oversized.map((f) => f.path)).not.toContain('.wi3388-cargo-target/big.bin');
      expect(oversized).toHaveLength(0);
    } finally {
      rmSync(bigFileDir, { recursive: true, force: true });
    }
  });
});
