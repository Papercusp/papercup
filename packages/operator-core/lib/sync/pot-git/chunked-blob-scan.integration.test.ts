/**
 * chunked-blob-scan.integration.test.ts — the bounded G-10 blob reader shared
 * by publish-guard (own namespace) and foreign-mirror-quarantine (untrusted
 * peer input). Real git, real repo; no mocks.
 *
 * The chunk-INVARIANCE property (same findings at any budget) is exercised
 * end-to-end through both guards' own suites. What lives here is the property
 * neither guard suite could reach: the FAIL-CLOSED posture on a chunk that
 * cannot be read. A mutation run (WI-6258) proved that gap concretely —
 * flipping `return { findings: [], error }` to `continue` left all 28 tests in
 * the two guard suites green, i.e. the fail-open hole this module documents
 * closing was, until this file, unguarded.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/chunked-blob-scan.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit } from './storage';
import { type BlobEntry, partitionBlobsForScan, scanTextBlobsChunked } from './chunked-blob-scan';

describe('chunked-blob-scan: bounded G-10 blob reading', () => {
  let root: string;
  let repo: string;
  let secretBlob: BlobEntry;
  let cleanBlob: BlobEntry;

  const hashBlob = async (name: string, content: string): Promise<BlobEntry> => {
    const f = join(root, name);
    await writeFile(f, content, 'utf8');
    const r = await defaultRunGit(['hash-object', '-w', f], repo);
    expect(r.code, r.stderr).toBe(0);
    return { oid: r.stdout.trim(), path: name, bytes: Buffer.byteLength(content) };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'chunkscan-'));
    repo = join(root, 'r.git');
    expect((await defaultRunGit(['init', '--bare', '-q', repo], root)).code).toBe(0);
    // Split so this source file does not itself carry a scannable key, and a
    // suffix that is NOT …EXAMPLE (secrets-guard deliberately exempts AWS's
    // documented example keys — a fixture using one is silently vacuous).
    secretBlob = await hashBlob(
      'leak.env',
      `# settings\n# managed\nAWS_ACCESS_KEY_ID=${'AKIA' + 'J7QK3RTZ2WLPX4NA'}\n`,
    );
    cleanBlob = await hashBlob('clean.ts', 'export const ok = 1;\n'.repeat(20));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('FAILS CLOSED when a chunk cannot be read — never reports "no findings"', async () => {
    // A path that is not a git repo makes `cat-file --batch` exit non-zero,
    // which is the real shape of "part of the range went unjudged".
    const notARepo = join(root, 'not-a-repo');
    const res = await scanTextBlobsChunked([secretBlob], notARepo, 32 * 1024 * 1024);

    // The distinction that matters: an unreadable chunk must be reported as an
    // ERROR, not as a clean scan. Both callers refuse on `error`, so a null
    // error here would admit an unjudged range — fail-OPEN in a fail-closed
    // guard, and in the quarantine's case over hostile input.
    expect(res.error).not.toBeNull();
    expect(res.error).toContain('cat-file --batch failed');
    expect(res.findings).toEqual([]);
  });

  it('a LATER unreadable chunk still fails closed, even after an earlier chunk scanned cleanly', async () => {
    // Guards the `continue`-shaped regression specifically: swallowing the
    // error would let the earlier chunk's (empty) result stand as the verdict.
    // A 1-byte budget forces one blob per chunk, so this really is chunk 2.
    const res = await scanTextBlobsChunked([cleanBlob, secretBlob], join(root, 'also-not-a-repo'), 1);
    expect(res.error).not.toBeNull();
    expect(res.findings).toEqual([]);
  });

  it('finds the secret when the repo IS readable — the fail-closed tests above are not vacuous', async () => {
    // Without this, both tests above would pass against a scanner that never
    // finds anything at all.
    const res = await scanTextBlobsChunked([cleanBlob, secretBlob], repo, 1);
    expect(res.error).toBeNull();
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.path).toBe('leak.env');
    expect(res.findings[0]?.line).toBe(3);
  });

  it('partitions by byte budget, preserves order, and never DROPS an over-budget blob', async () => {
    const blobs: BlobEntry[] = [
      { oid: 'a', path: 'a', bytes: 10 },
      { oid: 'b', path: 'b', bytes: 10 },
      { oid: 'big', path: 'big', bytes: 5_000 },
      { oid: 'c', path: 'c', bytes: 10 },
    ];
    const groups = partitionBlobsForScan(blobs, 25);
    // Coverage is never traded for the bound: the over-budget blob gets its
    // own group rather than being skipped.
    expect(groups.flat().map((b) => b.oid)).toEqual(['a', 'b', 'big', 'c']);
    expect(groups.some((g) => g.length === 1 && g[0]?.oid === 'big')).toBe(true);
  });
});
