import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBulkDirtyExcess, findOversizedDirtyFiles, type RunGit } from './run-git-sync';

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

/**
 * WI-5738 — the CUMULATIVE gate.
 *
 * The 2026-07-20 wedge got past `findOversizedDirtyFiles` because every single
 * file in an extracted AppImage was under the per-file cap (largest 90.3 MB vs
 * a 95 MB cap) — while the set totalled 2,261 MB. It committed cleanly, and the
 * aggregate then breached the publish guard's 500 MB TOTAL cap downstream,
 * where the only response was a terminal refusal that froze all p2p publishing
 * for five days.
 */
describe('findBulkDirtyExcess — the cumulative cap the per-file cap cannot see', () => {
  const sizedRunGit = (files: Record<string, number>): RunGit =>
    (async (args: string[]) => {
      if (args[0] === 'status') {
        return { code: 0, stdout: Object.keys(files).map((f) => `?? ${f}`).join('\0') + '\0', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }) as unknown as RunGit;

  it('excludes nothing when the cumulative set fits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-ok-'));
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(dir, 'b.bin'), Buffer.alloc(100));
    const out = await findBulkDirtyExcess(sizedRunGit({ 'a.bin': 100, 'b.bin': 100 }), dir, 1000);
    expect(out).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the incident shape: many individually-fine files that TOGETHER bust the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-incident-'));
    // Four 400-byte "artifacts" + one small source edit, cap 1000. Every file is
    // individually fine; only the SUM is the accident — the 2026-07-20 shape.
    const files: Record<string, number> = {};
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `artifact${i}.bin`), Buffer.alloc(400));
      files[`artifact${i}.bin`] = 400;
    }
    writeFileSync(join(dir, 'src.ts'), Buffer.alloc(20));
    files['src.ts'] = 20;

    const out = await findBulkDirtyExcess(sizedRunGit(files), dir, 1000);
    expect(out.length).toBeGreaterThan(0);
    const excludedPaths = out.map((f) => f.path);
    // The genuine source edit still commits this tick — quarantine, don't stall.
    expect(excludedPaths).not.toContain('src.ts');
    expect(excludedPaths.every((p) => p.startsWith('artifact'))).toBe(true);
    expect(out.every((f) => f.exclusionReason === 'cumulative-limit')).toBe(true);
    const remaining = 1620 - out.reduce((n, f) => n + f.sizeBytes, 0);
    expect(remaining).toBeLessThanOrEqual(1000);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not double-count files already excluded by the per-file cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-dedup-'));
    writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(900));
    writeFileSync(join(dir, 'small.bin'), Buffer.alloc(50));
    // huge.bin is already excluded upstream, so its bytes are NOT being
    // committed and must not drive a second exclusion.
    const out = await findBulkDirtyExcess(
      sizedRunGit({ 'huge.bin': 900, 'small.bin': 50 }),
      dir,
      100,
      new Set(['huge.bin']),
    );
    expect(out).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
