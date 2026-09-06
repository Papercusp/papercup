/**
 * github-ingress.integration.test.ts — P-002 ingress core
 * (github-bridge-hive-egress-2026-07-02; S-3/S-4): a real local bare "GitHub"
 * origin ingresses into the synthetic github-origin namespace — FF-only + CAS,
 * non-FF origin rewrites reported (never applied) unless allowNonFF.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/github-ingress.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit, ensurePotGitRepo, listNamespaces, readNamespaceRef, type RunGit } from './storage';
import {
  INGRESS_QUARANTINE_PREFIX,
  githubOriginDevicePubkey,
  githubOriginNamespaceKey,
  ingressOriginBranches,
} from './github-ingress';

async function commitFile(work: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  const add = await defaultRunGit(['add', '-A'], work);
  expect(add.code, add.stderr).toBe(0);
  const c = await defaultRunGit(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], work);
  expect(c.code, c.stderr).toBe(0);
  return (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
}

async function pushToOrigin(work: string, origin: string, force = false): Promise<void> {
  const args = ['push', '-q'];
  if (force) args.push('-f');
  args.push(origin, 'refs/heads/main:refs/heads/main');
  const p = await defaultRunGit(args, work);
  expect(p.code, p.stderr).toBe(0);
}

describe('github-ingress (P-002: GitHub-as-a-member via the synthetic namespace)', () => {
  let root: string;
  let store: string;
  let origin: string;
  let work: string;
  let devPubkey: string;
  let sha1: string;
  let sha2: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-ingress-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensurePotGitRepo('hive-bridge', 'repo-2');

    origin = join(root, 'origin.git');
    expect((await defaultRunGit(['init', '--bare', '-q', origin], root)).code).toBe(0);
    work = join(root, 'work');
    expect((await defaultRunGit(['init', '-q', '-b', 'main', work], root)).code).toBe(0);

    devPubkey = githubOriginDevicePubkey(origin);
    sha1 = await commitFile(work, 'a.txt', 'one\n', 'c1');
    await pushToOrigin(work, origin);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('first ingress creates the synthetic namespace head (from: null)', async () => {
    const r = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.namespaceKey).toBe(githubOriginNamespaceKey(origin));
    expect(r.updated).toEqual([{ branch: 'main', from: null, to: sha1, forced: false }]);
    expect(await readNamespaceRef(store, devPubkey, 'refs/heads/main')).toBe(sha1);
    // The synthetic namespace is a first-class namespace (64-hex) — visible to
    // every existing helper (listNamespaces, gc, bootstrap).
    expect(await listNamespaces(store)).toContain(r.namespaceKey);
  });

  it('re-ingress with no origin movement is upToDate', async () => {
    const r = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(r.updated).toEqual([]);
    expect(r.upToDate).toEqual(['main']);
  });

  it('an origin fast-forward advances the namespace (CAS on the read head)', async () => {
    sha2 = await commitFile(work, 'a.txt', 'two\n', 'c2');
    await pushToOrigin(work, origin);
    const r = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(r.errors).toEqual([]);
    expect(r.updated).toEqual([{ branch: 'main', from: sha1, to: sha2, forced: false }]);
    expect(await readNamespaceRef(store, devPubkey, 'refs/heads/main')).toBe(sha2);
  });

  it('deepens a shallow store before classifying a real fast-forward as a rewrite', async () => {
    const sha3 = await commitFile(work, 'a.txt', 'three\n', 'c3');
    await pushToOrigin(work, origin);

    // Reproduce the live Papercusp bridge state: the new remote tip is present,
    // but a retained shallow boundary hides its parent chain from merge-base.
    const quarantineRef = `${INGRESS_QUARANTINE_PREFIX}/${githubOriginNamespaceKey(origin)}/main`;
    const fetch = await defaultRunGit(['fetch', origin, `+refs/heads/main:${quarantineRef}`], store);
    expect(fetch.code, fetch.stderr).toBe(0);
    await writeFile(join(store, 'shallow'), `${sha3}\n`);
    const shallowLock = join(store, 'shallow.lock');
    await writeFile(shallowLock, '');
    const stale = new Date(Date.now() - 2 * 60_000);
    await utimes(shallowLock, stale, stale);
    const before = await defaultRunGit(['merge-base', '--is-ancestor', sha2, sha3], store);
    expect(before.code).not.toBe(0);

    const commands: string[][] = [];
    const runGit: RunGit = async (args, cwd, options) => {
      commands.push([...args]);
      return defaultRunGit(args, cwd, options);
    };
    const r = await ingressOriginBranches({
      repoPath: store,
      remoteUrl: origin,
      historySourcePath: work,
      branches: ['main'],
      runGit,
    });
    expect(r.errors).toEqual([]);
    expect(r.nonFF).toEqual([]);
    expect(r.updated).toEqual([{ branch: 'main', from: sha2, to: sha3, forced: false }]);
    expect(await readNamespaceRef(store, devPubkey, 'refs/heads/main')).toBe(sha3);
    expect((await defaultRunGit(['rev-parse', '--is-shallow-repository'], store)).stdout.trim()).toBe('false');
    await expect(access(shallowLock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(commands).toContainEqual(['fetch', '--unshallow', work, `+refs/heads/main:${quarantineRef}`]);
    sha2 = sha3;
  });

  it('a non-FF origin rewrite is REPORTED, the namespace does not move (S-4)', async () => {
    // Rewrite origin history: amend the tip and force-push.
    const amend = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--amend', '-m', 'c2-rewritten'],
      work,
    );
    expect(amend.code, amend.stderr).toBe(0);
    await pushToOrigin(work, origin, true);
    const rewritten = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect(rewritten).not.toBe(sha2);

    const r = await ingressOriginBranches({ repoPath: store, remoteUrl: origin, branches: ['main'] });
    expect(r.updated).toEqual([]);
    expect(r.nonFF).toEqual([{ branch: 'main', local: sha2, remote: rewritten }]);
    // Visible, not destructive: the namespace still holds the pre-rewrite head.
    expect(await readNamespaceRef(store, devPubkey, 'refs/heads/main')).toBe(sha2);
  });

  it('allowNonFF (the P-006 owner lever) accepts the rewrite explicitly', async () => {
    const rewritten = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    const r = await ingressOriginBranches({
      repoPath: store,
      remoteUrl: origin,
      branches: ['main'],
      allowNonFF: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.updated).toEqual([{ branch: 'main', from: sha2, to: rewritten, forced: true }]);
    expect(await readNamespaceRef(store, devPubkey, 'refs/heads/main')).toBe(rewritten);
  });

  it('a branch absent on origin lands in `absent`, never errors', async () => {
    const r = await ingressOriginBranches({
      repoPath: store,
      remoteUrl: origin,
      branches: ['no-such-branch', 'main'],
    });
    expect(r.ok).toBe(true);
    expect(r.absent).toEqual(['no-such-branch']);
    expect(r.upToDate).toEqual(['main']); // the other branch still processed
  });

  it('an unsafe branch name is rejected per-branch, the rest proceed', async () => {
    const r = await ingressOriginBranches({
      repoPath: store,
      remoteUrl: origin,
      branches: ['../escape', 'main'],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].branch).toBe('../escape');
    expect(r.upToDate).toEqual(['main']);
  });

  it('an unreachable remote folds into errors (ok:false), never throws', async () => {
    const r = await ingressOriginBranches({
      repoPath: store,
      remoteUrl: join(root, 'no-such-origin.git'),
      branches: ['main'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
