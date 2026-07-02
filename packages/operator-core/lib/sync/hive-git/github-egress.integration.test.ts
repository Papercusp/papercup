/**
 * github-egress.integration.test.ts — P-001 egress core
 * (github-bridge-hive-egress-2026-07-02; S-1/S-2/S-4): canonical refs publish
 * to a real local bare "GitHub" origin, FF-only, never forced, secrets-gated,
 * tags create-only.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/github-egress.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit, ensureHiveGitRepo, namespaceRefPath } from './storage';
import { STAGING_REF } from './integrator';
import { egressCanonicalRefs } from './github-egress';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Commit a file in the scratch WORK repo (a normal worktree repo). */
async function commitFile(work: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  const add = await defaultRunGit(['add', '-A'], work);
  expect(add.code, add.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg],
    work,
  );
  expect(c.code, c.stderr).toBe(0);
  const rev = await defaultRunGit(['rev-parse', 'HEAD'], work);
  expect(rev.code, rev.stderr).toBe(0);
  return rev.stdout.trim();
}

/** Move the work repo's branch head into the store's integrator namespace. */
async function publishToStore(store: string, work: string, branch: string, nsRef: string): Promise<void> {
  const f = await defaultRunGit(['fetch', work, `+refs/heads/${branch}:${nsRef}`], store);
  expect(f.code, f.stderr).toBe(0);
}

async function originSha(origin: string, ref: string): Promise<string | null> {
  const r = await defaultRunGit(['rev-parse', '--verify', '-q', `${ref}^{object}`], origin);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

describe('github-egress (P-001: canonical refs → GitHub, FF-only, secrets-gated)', () => {
  let root: string;
  let store: string;
  let origin: string;
  let work: string;
  const integrator = devicePubkey();
  let stagingNsRef: string;
  let sha1: string;
  let sha2: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-egress-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensureHiveGitRepo('hive-bridge', 'repo-1');
    stagingNsRef = namespaceRefPath(integrator, STAGING_REF);

    origin = join(root, 'origin.git');
    const initOrigin = await defaultRunGit(['init', '--bare', '-q', origin], root);
    expect(initOrigin.code, initOrigin.stderr).toBe(0);

    work = join(root, 'work');
    const initWork = await defaultRunGit(['init', '-q', '-b', 'main', work], root);
    expect(initWork.code, initWork.stderr).toBe(0);

    sha1 = await commitFile(work, 'a.txt', 'hello\n', 'c1');
    await publishToStore(store, work, 'main', stagingNsRef);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('first egress creates the remote branch (from: null)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([{ remoteRef: 'refs/heads/staging', from: null, to: sha1 }]);
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha1);
  });

  it('re-egress of the same sha is upToDate (no push)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([]);
    expect(r.upToDate).toEqual(['refs/heads/staging']);
  });

  it('fast-forward advance pushes from→to', async () => {
    sha2 = await commitFile(work, 'a.txt', 'hello world\n', 'c2');
    await publishToStore(store, work, 'main', stagingNsRef);
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.errors).toEqual([]);
    expect(r.pushed).toEqual([{ remoteRef: 'refs/heads/staging', from: sha1, to: sha2 }]);
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha2);
  });

  it('a diverged origin is rejectedNonFF and NEVER overwritten (S-4)', async () => {
    // Simulate a GitHub-side rewrite: an unrelated root commit replaces staging.
    const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], origin);
    expect(tree.code, tree.stderr).toBe(0);
    const alien = await defaultRunGit(
      ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree.stdout.trim(), '-m', 'alien'],
      origin,
    );
    expect(alien.code, alien.stderr).toBe(0);
    const alienSha = alien.stdout.trim();
    const move = await defaultRunGit(['update-ref', 'refs/heads/staging', alienSha], origin);
    expect(move.code, move.stderr).toBe(0);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.rejectedNonFF).toHaveLength(1);
    expect(r.rejectedNonFF[0].remoteRef).toBe('refs/heads/staging');
    expect(r.rejectedNonFF[0].remoteSha).toBe(alienSha);
    // Origin untouched — the divergence is P-006's to reconcile, never forced.
    expect(await originSha(origin, 'refs/heads/staging')).toBe(alienSha);

    // Restore origin to the canonical line for the following tests.
    const restore = await defaultRunGit(['update-ref', 'refs/heads/staging', sha2], origin);
    expect(restore.code, restore.stderr).toBe(0);
  });

  it('a secret in the published delta BLOCKS egress (nothing leaves)', async () => {
    // Constructed at runtime so no token-shaped literal lives in the source.
    const fakeToken = `ghp_${'a'.repeat(40)}`;
    const secretSha = await commitFile(work, 'oops.env', `token=${fakeToken}\n`, 'c3-secret');
    await publishToStore(store, work, 'main', stagingNsRef);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: secretSha, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].remoteRef).toBe('refs/heads/staging');
    expect(r.blockedSecrets[0].findings.some((f) => f.rule === 'github-token')).toBe(true);
    // Origin still at the pre-secret sha.
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha2);
  });

  it('a secret committed THEN DELETED in the range still blocks (history scan)', async () => {
    // work head currently carries the secret commit; delete the file on top —
    // the endpoint diff sha2..head is now clean, but history is not.
    const rmFile = await defaultRunGit(['rm', '-q', 'oops.env'], work);
    expect(rmFile.code, rmFile.stderr).toBe(0);
    const c = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c4-remove-secret'],
      work,
    );
    expect(c.code, c.stderr).toBe(0);
    const head = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    await publishToStore(store, work, 'main', stagingNsRef);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: head, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].findings.some((f) => f.rule === 'github-token')).toBe(true);
  });

  it('scan-overflow fails closed (secret_scan_overflow posture)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/overflow-probe' }],
      maxScanFiles: 1, // sha2's history introduces >1 blob
    });
    expect(r.pushed).toEqual([]);
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].overflow).toBe(true);
    expect(await originSha(origin, 'refs/heads/overflow-probe')).toBeNull();
  });

  it('release tags are create-only: new tag pushes, an existing tag never moves', async () => {
    const r1 = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [],
      tags: [{ name: 'release-1', sha: sha1 }],
    });
    expect(r1.errors).toEqual([]);
    expect(r1.tagsPushed).toEqual(['release-1']);
    expect(await originSha(origin, 'refs/tags/release-1')).toBe(sha1);

    const r2 = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [],
      tags: [
        { name: 'release-1', sha: sha2 }, // exists at sha1 → rejected
        { name: 'release-1', sha: sha1 }, // duplicate at same sha → upToDate
      ],
    });
    expect(r2.tagsPushed).toEqual([]);
    expect(r2.tagsRejected).toHaveLength(1);
    expect(r2.tagsRejected[0].name).toBe('release-1');
    expect(r2.upToDate).toContain('refs/tags/release-1');
    expect(await originSha(origin, 'refs/tags/release-1')).toBe(sha1);
  });

  it('an unreachable remote folds into errors (ok:false), never throws', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: join(root, 'no-such-origin.git'),
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.pushed).toEqual([]);
  });
});
