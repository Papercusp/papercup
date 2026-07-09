/**
 * github-ingress-admission.integration.test.ts — P-005 ingress admission
 * (github-bridge-hive-egress-2026-07-02; S-6): revoked GitHub authors block a
 * github-origin head from integration; unknown authors are reported, never
 * blocked; errors fail CLOSED. Real git, injected revocation seam (no PG).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/github-ingress-admission.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit } from './storage';
import { admitGithubOriginHead, githubUserIdFromEmail } from './github-ingress-admission';

async function commitAs(work: string, email: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  expect((await defaultRunGit(['add', '-A'], work)).code).toBe(0);
  const c = await defaultRunGit(
    ['-c', `user.name=t`, '-c', `user.email=${email}`, 'commit', '-q', '-m', msg],
    work,
  );
  expect(c.code, c.stderr).toBe(0);
  return (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
}

describe('githubUserIdFromEmail (the noreply mapping)', () => {
  it('maps the id+login noreply form; legacy/plain emails → null', () => {
    expect(githubUserIdFromEmail('123456+octocat@users.noreply.github.com')).toBe(123456);
    expect(githubUserIdFromEmail('octocat@users.noreply.github.com')).toBeNull(); // legacy, no id
    expect(githubUserIdFromEmail('dev@example.com')).toBeNull();
    expect(githubUserIdFromEmail('0+zero@users.noreply.github.com')).toBeNull(); // non-positive id
  });
});

describe('github-ingress-admission (P-005: revocation gate between ingress and integration)', () => {
  let root: string;
  let work: string;
  let base: string; // the last-admitted head
  let cleanHead: string;
  const scope = { workspaceId: 'ws-1', potHomeSlug: 'hive-bridge' };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-adm-'));
    work = join(root, 'repo');
    expect((await defaultRunGit(['init', '-q', '-b', 'main', work], root)).code).toBe(0);
    base = await commitAs(work, '111+alice@users.noreply.github.com', 'a.txt', 'base\n', 'c0');
    cleanHead = await commitAs(work, '111+alice@users.noreply.github.com', 'a.txt', 'one\n', 'c1');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first ingress (lastAdmitted null) admits as baseline — history is not a contribution', async () => {
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: null,
      head: cleanHead,
      ...scope,
      isRevoked: async () => {
        throw new Error('must not be called on baseline');
      },
    });
    expect(r).toMatchObject({ admit: true, basis: 'baseline' });
  });

  it('a clean range admits, with every mapped author checked', async () => {
    const checked: number[] = [];
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head: cleanHead,
      ...scope,
      isRevoked: async (id) => {
        checked.push(id);
        return false;
      },
    });
    expect(r).toMatchObject({ admit: true, basis: 'clean' });
    expect(r.checkedAuthorIds).toEqual([111]);
    expect(checked).toEqual([111]);
  });

  it('a REVOKED author in the range blocks the head (with the offending commits)', async () => {
    const badSha = await commitAs(work, '222+mallory@users.noreply.github.com', 'b.txt', 'evil\n', 'c2');
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head: badSha,
      ...scope,
      isRevoked: async (id) => id === 222,
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('blocked');
    expect(r.blockedAuthors).toHaveLength(1);
    expect(r.blockedAuthors[0].githubUserId).toBe(222);
    expect(r.blockedAuthors[0].commits).toContain(badSha);
  });

  it('an unmappable author email is REPORTED, never blocked (trust gate owns unknowns)', async () => {
    const head = await commitAs(work, 'dev@example.com', 'c.txt', 'plain\n', 'c3');
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head,
      ...scope,
      isRevoked: async () => false,
    });
    expect(r.admit).toBe(true);
    expect(r.unknownAuthors).toContain('dev@example.com');
  });

  it('the injected wider resolver maps a plain email when provided', async () => {
    const head = await commitAs(work, 'mapped@example.com', 'd.txt', 'mapped\n', 'c4');
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head,
      ...scope,
      resolveGithubUserId: async (email) => (email === 'mapped@example.com' ? 333 : null),
      isRevoked: async (id) => id === 333,
    });
    expect(r.admit).toBe(false);
    expect(r.blockedAuthors[0]?.githubUserId).toBe(333);
  });

  it('a range over the cap fails CLOSED', async () => {
    const head = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head,
      ...scope,
      maxRangeCommits: 1,
      isRevoked: async () => false,
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('error');
    expect(r.errors[0]).toMatch(/refusing to judge/);
  });

  it('a revocation-check ERROR fails CLOSED (trust decision)', async () => {
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: base,
      head: cleanHead,
      ...scope,
      isRevoked: async () => {
        throw new Error('pg down');
      },
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('error');
  });

  it('a git failure (bogus shas) fails CLOSED', async () => {
    const r = await admitGithubOriginHead({
      repoPath: work,
      lastAdmitted: 'e'.repeat(40),
      head: 'f'.repeat(40),
      ...scope,
      isRevoked: async () => false,
    });
    expect(r.admit).toBe(false);
    expect(r.basis).toBe('error');
  });
});
