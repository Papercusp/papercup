/**
 * chunked-blob-scan.test.ts — the G-10 scan-verdict memo (WI-10002541 /
 * WI-10002478).
 *
 * The findings for a blob are a pure function of (path, content), and a git oid
 * IS its content, yet every judgment used to re-read (`cat-file --batch` + a
 * UTF-8 decode) and re-scan the same immutable blobs: twice per commit
 * (own-head-publish, then ref-announce), log2(n)+2 more times per tick in
 * resolveIncrementalPublishSha's binary search, and on EVERY git-sync tick
 * while a hard refusal pinned a baseline. On the rig VM that held 19-28% of the
 * operator main thread.
 *
 * These tests PIN THE CALL COUNTS — how often `scanForSecrets` runs and how
 * many `cat-file --batch` reads happen — so a regression back to re-scanning
 * fails here, not as a CPU profile on a live box. They also pin the safety
 * edges of the key: path (the FIXTURE_FILES exemption is per path) and repo
 * (an unreadable store must still fail closed).
 *
 * `cat-file --batch` is served from an in-memory object store, so this is a
 * unit test; the real-git FAIL-CLOSED property lives in
 * chunked-blob-scan.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const git = vi.hoisted(() => ({
  repos: new Map<string, Map<string, Buffer>>(),
  calls: [] as { cwd: string; oids: string[] }[],
}));

vi.mock('./storage', () => ({
  defaultRunGitStdin: vi.fn(async (_args: string[], cwd: string, stdin: string) => {
    const oids = stdin.split('\n').filter(Boolean);
    git.calls.push({ cwd, oids });
    const store = git.repos.get(cwd);
    if (!store) {
      return { code: 128, stdout: Buffer.alloc(0), stderr: `fatal: not a git repository: ${cwd}` };
    }
    const parts: Buffer[] = [];
    for (const oid of oids) {
      const body = store.get(oid);
      if (!body) {
        parts.push(Buffer.from(`${oid} missing\n`));
        continue;
      }
      parts.push(Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from('\n'));
    }
    return { code: 0, stdout: Buffer.concat(parts), stderr: '' };
  }),
}));

vi.mock('./secrets-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets-guard')>();
  return { ...actual, scanForSecrets: vi.fn(actual.scanForSecrets) };
});

import { scanForSecrets } from './secrets-guard';
import {
  BLOB_SCAN_VERDICT_CACHE_MAX,
  type BlobEntry,
  getBlobScanCacheStats,
  resetBlobScanCacheForTests,
  scanTextBlobsChunked,
} from './chunked-blob-scan';

const REPO = '/fake/pot-git.git';
const BIG = 32 * 1024 * 1024;
// Split so this source file does not itself carry a scannable key; the suffix
// is NOT ...EXAMPLE (secrets-guard exempts AWS's documented example keys).
const LEAK_A = `AWS_ACCESS_KEY_ID=${'AKIA' + 'J7QK3RTZ2WLPX4NA'}\n`;
const LEAK_B = `# other\nAWS_ACCESS_KEY_ID=${'AKIA' + 'Q2WE4RTY6UIO8PAS'}\n`;
const FIXTURE_PATH = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';

let nextOid = 1;
function blob(path: string, content: string | Buffer, repo = REPO): BlobEntry {
  const oid = (nextOid++).toString(16).padStart(40, '0');
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (!git.repos.has(repo)) git.repos.set(repo, new Map());
  git.repos.get(repo)!.set(oid, body);
  return { oid, path, bytes: body.length };
}

const scanCalls = () => vi.mocked(scanForSecrets).mock.calls.length;
const rules = (fs: { path: string; rule: string }[]) => fs.map((f) => [f.path, f.rule]);

describe('scanTextBlobsChunked: scan-verdict memo', () => {
  beforeEach(() => {
    resetBlobScanCacheForTests();
    git.repos.clear();
    git.calls.length = 0;
    vi.mocked(scanForSecrets).mockClear();
    git.repos.set(REPO, new Map());
  });

  it('reads and scans each blob ONCE across repeated judgments of the same range (the per-tick re-scan)', async () => {
    const blobs = [blob('a.ts', 'export const a = 1;\n'), blob('leak.env', LEAK_A), blob('b.ts', 'export const b = 2;\n')];

    const first = await scanTextBlobsChunked(blobs, REPO, BIG);
    expect(first.error).toBeNull();
    expect(rules(first.findings)).toEqual([['leak.env', 'aws-access-key-id']]);
    expect(scanCalls()).toBe(3);
    expect(git.calls).toHaveLength(1);

    // Five more ticks judging the identical (still refused) range.
    for (let tick = 0; tick < 5; tick++) {
      expect(await scanTextBlobsChunked(blobs, REPO, BIG)).toEqual(first);
    }
    expect(scanCalls()).toBe(3); // was 18 before the memo
    expect(git.calls).toHaveLength(1); // was 6 cat-file --batch reads
    expect(getBlobScanCacheStats()).toMatchObject({ misses: 3, hits: 15, size: 3 });
  });

  it('re-judging nested prefixes (resolveIncrementalPublishSha binary search) reads nothing new; a grown range reads only the new blob', async () => {
    const blobs = [blob('a.ts', 'a\n'), blob('b.ts', 'b\n'), blob('c.ts', 'c\n'), blob('d.ts', 'd\n')];
    await scanTextBlobsChunked(blobs, REPO, BIG);
    expect(scanCalls()).toBe(4);

    await scanTextBlobsChunked(blobs.slice(0, 2), REPO, BIG);
    await scanTextBlobsChunked(blobs.slice(0, 3), REPO, BIG);
    await scanTextBlobsChunked(blobs.slice(0, 1), REPO, BIG);
    expect(scanCalls()).toBe(4);
    expect(git.calls).toHaveLength(1);

    const grown = [...blobs, blob('e.ts', 'e\n')];
    await scanTextBlobsChunked(grown, REPO, BIG);
    expect(scanCalls()).toBe(5);
    expect(git.calls).toHaveLength(2);
    expect(git.calls[1].oids).toEqual([grown[4].oid]);
  });

  it('keys on PATH: a fixture-path verdict never answers for the same bytes committed elsewhere', async () => {
    const atFixture = blob(FIXTURE_PATH, LEAK_A);
    const exempt = await scanTextBlobsChunked([atFixture], REPO, BIG);
    expect(exempt.findings).toEqual([]);

    // Same oid (same bytes), ordinary path: must be judged, and must be found.
    const elsewhere: BlobEntry = { ...atFixture, path: 'leak.env' };
    const found = await scanTextBlobsChunked([elsewhere], REPO, BIG);
    expect(rules(found.findings)).toEqual([['leak.env', 'aws-access-key-id']]);
    expect(scanCalls()).toBe(2);
  });

  it('keys on REPO: an unreadable store still FAILS CLOSED after another store judged the same blob', async () => {
    const leak = blob('leak.env', LEAK_A);
    expect(rules((await scanTextBlobsChunked([leak], REPO, BIG)).findings)).toEqual([['leak.env', 'aws-access-key-id']]);

    const res = await scanTextBlobsChunked([leak], '/fake/not-a-repo', BIG);
    expect(res.findings).toEqual([]);
    expect(res.error).toMatch(/cat-file --batch failed/);
  });

  it('memoizes BINARY blobs as clean (no re-read), but re-attempts a MISSING object every time', async () => {
    const bin = blob('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const missing: BlobEntry = { oid: 'f'.repeat(40), path: 'later.env', bytes: 10 };

    const first = await scanTextBlobsChunked([bin, missing], REPO, BIG);
    expect(first).toEqual({ findings: [], error: null });
    expect(scanCalls()).toBe(0);
    expect(git.calls[0].oids).toEqual([bin.oid, missing.oid]);

    await scanTextBlobsChunked([bin, missing], REPO, BIG);
    expect(git.calls[1].oids).toEqual([missing.oid]); // binary remembered, missing retried

    // The object arrives: it is judged now, not answered from a stale "clean".
    git.repos.get(REPO)!.set(missing.oid, Buffer.from(LEAK_A));
    const third = await scanTextBlobsChunked([bin, missing], REPO, BIG);
    expect(rules(third.findings)).toEqual([['later.env', 'aws-access-key-id']]);
  });

  it('returns COPIES: a caller mutating a finding cannot poison the next judgment', async () => {
    const leak = blob('leak.env', LEAK_A);
    const first = await scanTextBlobsChunked([leak], REPO, BIG);
    first.findings[0].path = 'tampered';
    first.findings[0].rule = 'tampered';
    const second = await scanTextBlobsChunked([leak], REPO, BIG);
    expect(rules(second.findings)).toEqual([['leak.env', 'aws-access-key-id']]);
  });

  it('keeps the un-memoized ORDER when cached and fresh blobs interleave across chunks', async () => {
    const a = blob('a.env', LEAK_A);
    const clean = blob('clean.ts', 'export const ok = 1;\n');
    const b = blob('b.env', LEAK_B);
    await scanTextBlobsChunked([b], REPO, BIG); // b cached, a/clean fresh

    const res = await scanTextBlobsChunked([a, clean, b], REPO, 1); // one blob per chunk
    expect(rules(res.findings)).toEqual([
      ['a.env', 'aws-access-key-id'],
      ['b.env', 'aws-access-key-id'],
    ]);
    expect(res.findings.map((f) => f.line)).toEqual([1, 2]);
  });

  it('is BOUNDED: past the cap the oldest verdict is evicted and simply re-judged later', async () => {
    expect(BLOB_SCAN_VERDICT_CACHE_MAX).toBeGreaterThanOrEqual(50_000); // >= one flood-capped publish
    resetBlobScanCacheForTests({ max: 2 });
    const [x, y, z] = [blob('x.ts', 'x\n'), blob('y.ts', 'y\n'), blob('z.ts', 'z\n')];
    await scanTextBlobsChunked([x, y, z], REPO, BIG);
    expect(getBlobScanCacheStats()).toMatchObject({ size: 2, evictions: 1 });

    await scanTextBlobsChunked([x], REPO, BIG); // x was the oldest → evicted → re-read
    expect(git.calls).toHaveLength(2);
    expect(git.calls[1].oids).toEqual([x.oid]);
    expect(scanCalls()).toBe(4);
  });
});
