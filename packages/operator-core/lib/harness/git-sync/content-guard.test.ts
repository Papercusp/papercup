/**
 * The git-sync content guard (git-sync-content-guard-2026-06-13 P-001/P-008).
 *
 * Pure + seam-injected (runGit, readText, detectors) — no real repo, no fs. Pins
 * the load-bearing behavior:
 *   - parses the `--porcelain -z -uall` dirty list (skips deletions, resolves
 *     rename pairs), runs only the detectors whose scope matches each path;
 *   - reads ONLY files at least one detector targets (no fs cost for the rest);
 *   - FAILS OPEN — a detector or a read that THROWS is skipped, never an offender
 *     (a content-check bug must never wedge the whole tree's commit).
 */
import { describe, it, expect, vi } from 'vitest';
import { detectContentOffenders, parseDirtyPaths } from './content-guard';
import type { ContentDetector } from '../../content-lint/registry';
import type { RunGit } from './run-git-sync';

/** A runGit that answers `status --porcelain -z -uall` with the given NUL-joined entries. */
const statusRunGit = (entries: string[]): RunGit =>
  async (args) =>
    args[0] === 'status'
      ? { code: 0, stdout: entries.join('\0') + (entries.length ? '\0' : ''), stderr: '' }
      : { code: 0, stdout: '', stderr: '' };

/** A detector that flags any file whose text contains `BROKEN`. */
const makeDetector = (over: Partial<ContentDetector> = {}): ContentDetector => ({
  key: 'fake',
  glob: '**/*.mdx',
  matches: (f) => f.endsWith('.mdx'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'is broken' : null),
  fixerRole: 'content-fixer',
  ...over,
});

describe('parseDirtyPaths', () => {
  it('extracts dirty paths, skipping deletions and resolving -z rename pairs', () => {
    const z = [' M src/a.ts', '?? docs/x.mdx', ' D gone.ts', 'R  new.ts\0old.ts'].join('\0') + '\0';
    // The rename entry "R  new.ts" is followed by its origin "old.ts" as a separate
    // \0 field; parseDirtyPaths keeps `new.ts` and skips `old.ts` + the deletion.
    expect(parseDirtyPaths(z)).toEqual(['src/a.ts', 'docs/x.mdx', 'new.ts']);
  });

  it('returns [] for an empty porcelain output', () => {
    expect(parseDirtyPaths('')).toEqual([]);
  });
});

describe('detectContentOffenders', () => {
  const base = { repoPath: '/repo', detectors: [makeDetector()] };

  it('flags a dirty file the detector rejects, carrying file + key + error + fixerRole', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/bad.mdx', ' M docs/ok.mdx']),
      readText: async (rel) => (rel === 'docs/bad.mdx' ? 'this is BROKEN' : 'this is fine'),
    });
    expect(offenders).toEqual([
      { file: 'docs/bad.mdx', detectorKey: 'fake', error: 'is broken', fixerRole: 'content-fixer' },
    ]);
  });

  it('reads ONLY files a detector targets (no fs cost for the rest)', async () => {
    const readText = vi.fn(async () => 'clean');
    await detectContentOffenders({
      ...base,
      runGit: statusRunGit([' M src/a.ts', '?? docs/x.mdx', ' M src/b.tsx']),
      readText,
    });
    // only the .mdx matched the detector → only it was read
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledWith('docs/x.mdx');
  });

  it('FAILS OPEN — a detector that THROWS is skipped, never an offender', async () => {
    const log = vi.fn();
    const offenders = await detectContentOffenders({
      ...base,
      detectors: [makeDetector({ detect: () => { throw new Error('detector bug'); } })],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'BROKEN',
      log,
    });
    expect(offenders).toEqual([]); // the throw did not become a blocking offender
    expect(log).toHaveBeenCalledWith(expect.stringContaining('threw'));
  });

  it('FAILS OPEN — a file that cannot be read is skipped (null), not an offender', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => null, // gone / binary / permission
    });
    expect(offenders).toEqual([]);
  });

  it('runs MULTIPLE matching detectors over one file and collects every hit', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [
        makeDetector({ key: 'a', detect: () => 'err-a' }),
        makeDetector({ key: 'b', detect: () => 'err-b' }),
      ],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'anything',
    });
    expect(offenders.map((o) => o.detectorKey).sort()).toEqual(['a', 'b']);
  });

  it('is a no-op (empty) when no detectors are registered', async () => {
    const readText = vi.fn(async () => 'x');
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText,
    });
    expect(offenders).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });

  it('fails open when `git status` itself errors (returns no offenders)', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: async () => ({ code: 1, stdout: '', stderr: 'fatal' }),
      readText: async () => 'BROKEN',
    });
    expect(offenders).toEqual([]);
  });
});
