/**
 * publish-guard.integration.test.ts — the own-namespace publish admission
 * gate (G-10, p2p-git-live-activation-2026-07-09 / P-205) against a REAL
 * temp bare repo (git on PATH, no network). Mirrors gc.integration.test.ts's
 * fixture conventions.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/publish-guard.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePotGitRepo } from './storage';
import { checkPublishGuard, describePublishRefusal } from './publish-guard';

let commitCounter = 0;

async function commit(repo: string, files: Record<string, string>, parent?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pg-commit-'));
  try {
    commitCounter += 1;
    const ts = String(1_700_000_000 + commitCounter);
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: ts,
      GIT_COMMITTER_DATE: ts,
      GIT_INDEX_FILE: join(dir, 'index'),
    };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'publish-guard'];
    if (parent) args.push('-p', parent);
    return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('hive-git publish-guard (real bare repo)', () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hivegit-pubguard-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-pubguard', 'repo-1');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('admits a clean range with new safe content', async () => {
    const base = await commit(repo, { 'f.txt': 'hello' });
    const next = await commit(repo, { 'f.txt': 'hello world', 'g.txt': 'more' }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next });
    expect(res.ok).toBe(true);
    expect(res.refusalCode).toBeNull();
    expect(res.secretFindings).toEqual([]);
    expect(res.oversizeBlobs).toEqual([]);
    expect(describePublishRefusal(res)).toBe('publish admitted');
  });

  it('admits a first-ever publish (fromOid: null) judging full reachable history', async () => {
    const base = await commit(repo, { 'first.txt': 'ok' });
    const res = await checkPublishGuard({ repoPath: repo, fromOid: null, toOid: base });
    expect(res.ok).toBe(true);
    expect(res.newObjectCount).toBeGreaterThan(0);
  });

  it('is a no-op admit when the range introduces no new objects', async () => {
    const same = await commit(repo, { 'noop.txt': 'x' });
    const res = await checkPublishGuard({ repoPath: repo, fromOid: same, toOid: same });
    expect(res.ok).toBe(true);
    expect(res.newObjectCount).toBe(0);
  });

  it('refuses a range carrying a secret in new text content', async () => {
    const base = await commit(repo, { 'clean.txt': 'nothing to see' });
    // Built via concatenation (never a literal contiguous token in this source file) — a
    // REAL-shaped AWS access-key-id fed only into an in-memory temp git commit for this
    // test fixture, never a literal secret sitting in the tree.
    const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const withSecret = await commit(repo, { 'config.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: withSecret });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('secrets');
    expect(res.secretFindings.length).toBeGreaterThan(0);
    expect(res.secretFindings[0].rule).toBe('aws-access-key-id');
    expect(describePublishRefusal(res)).toContain('secret(s) found');
  });

  it('refuses a range carrying a blob over the size cap', async () => {
    const base = await commit(repo, { 'ok.txt': 'fine' });
    const withBigBlob = await commit(repo, { 'big.bin': 'placeholder' }, base);
    // Exercise the cap boundary via a deliberately low maxBlobBytes against the (small)
    // tracked blob, rather than committing a real 100MB fixture blob into the test tree.
    const res = await checkPublishGuard({
      repoPath: repo,
      fromOid: base,
      toOid: withBigBlob,
      caps: { maxBlobBytes: 4 }, // 'placeholder' (11 bytes) > 4
    });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('blob-over-cap');
    expect(res.oversizeBlobs.length).toBeGreaterThan(0);
    expect(describePublishRefusal(res)).toContain('oversized blob');
  });

  it('refuses when the new-object count exceeds the flood cap', async () => {
    const base = await commit(repo, { 'seed.txt': 'seed' });
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = `content-${i}`;
    const next = await commit(repo, files, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next, caps: { maxNewObjects: 3 } });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('object-flood');
    expect(describePublishRefusal(res)).toContain('exceeds the object-count cap');
  });

  it('refuses when total new bytes exceed the total cap', async () => {
    const base = await commit(repo, { 'seed2.txt': 'seed' });
    const next = await commit(repo, { 'payload.txt': 'x'.repeat(1000) }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next, caps: { maxTotalNewBytes: 100 } });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('total-over-cap');
    expect(describePublishRefusal(res)).toContain('total-new-bytes cap');
  });

  it('fails closed on a git error (unresolvable oid)', async () => {
    const res = await checkPublishGuard({ repoPath: repo, fromOid: null, toOid: 'not-a-real-oid' });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('error');
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
