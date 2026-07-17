/**
 * own-head-publish.integration.test.ts — G-2a (WI-5146): the worktree→own-
 * namespace first link. Real git end-to-end: a real worktree with real
 * commits, the real bare store (ensurePotGitRepo under a temp
 * PAPERCUSP_HIVE_GIT_ROOT), the real G-10 guard on the transferred range.
 *
 * The failure this file pins down: before this tick existed, every production
 * leg (bootstrap/announce/integrator/worktree-bridge) consumed namespace refs
 * that nothing in production ever wrote — live-caught on the tower↔VM rig
 * 2026-07-17 as "bridged mode produces no bare store at all".
 *
 * Run: npm run test:file -- packages/operator-core/lib/sync/pot-git/own-head-publish.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultRunGit,
  hiveGitRepoPath,
  listNamespaces,
  readNamespaceRef,
} from './storage';
import { runOwnHeadPublishTick } from './own-head-publish';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

const HIVE = 'hive-ohp';
const REPO_KEY = 'repo-ohp';
const BRANCH = 'master';

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function commitFile(worktree: string, name: string, content: string, msg: string): Promise<string> {
  await writeFile(join(worktree, name), content);
  await git(['add', '-A'], worktree);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

describe('own-head publish (G-2a: worktree head → own namespace, guarded)', () => {
  let root: string;
  let worktree: string;
  let oldRoot: string | undefined;
  const dev = devicePubkey();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgohp-'));
    oldRoot = process.env.PAPERCUSP_HIVE_GIT_ROOT;
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    worktree = join(root, 'worktree');
    await git(['init', '-q', '-b', BRANCH, worktree], root);
  });

  afterAll(async () => {
    if (oldRoot === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    else process.env.PAPERCUSP_HIVE_GIT_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('an unborn branch is a ran:false no-op — no store is created for nothing', async () => {
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(false);
    expect(out.changed).toBe(false);
  });

  it('first publish creates the store and lands the head in the own namespace', async () => {
    const sha = await commitFile(worktree, 'a.txt', 'hello\n', 'first');
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.errors, out.errors.join('; ')).toEqual([]);
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.headSha).toBe(sha);
    expect(out.priorSha).toBeNull();

    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha);
    expect(await listNamespaces(repoPath)).toHaveLength(1);
    // The published commit is a real, connected object in the shared ODB.
    const type = await git(['cat-file', '-t', sha], repoPath);
    expect(type).toBe('commit');
  });

  it('an unmoved head is a free changed:false no-op', async () => {
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.refused).toBeNull();
  });

  it('a new commit advances the namespace ref to the new head', async () => {
    const sha2 = await commitFile(worktree, 'b.txt', 'more\n', 'second');
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.changed).toBe(true);
    expect(out.headSha).toBe(sha2);
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha2);
  });

  it('G-10 refuses a planted credential: ref unchanged, nothing newly advertised', async () => {
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    const before = await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`);
    const refsBefore = await git(['for-each-ref', '--format=%(refname)'], repoPath);

    // A live-looking AWS access key id + secret pair (the secrets-guard's
    // canonical detector class).
    await commitFile(
      worktree,
      'oops.env',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      'oops secrets',
    );
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.refused).not.toBeNull();
    expect(out.refused!.refusalCode).toBe('secrets');
    // The namespace ref did not move and no new ref of any kind appeared —
    // the refused objects are unreachable, never servable.
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(before);
    expect(await git(['for-each-ref', '--format=%(refname)'], repoPath)).toBe(refsBefore);

    // Roll the bad commit away; the next head publishes cleanly again.
    await git(['reset', '--hard', 'HEAD~1'], worktree);
    const sha3 = await commitFile(worktree, 'c.txt', 'clean\n', 'clean again');
    const out2 = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out2.changed).toBe(true);
    expect(out2.headSha).toBe(sha3);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha3);
  });

  it('resolves the checked-out branch when cfg gives none; detached HEAD is a no-op', async () => {
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    const head = await git(['rev-parse', 'HEAD'], worktree);
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      devicePubkeyBase64: dev,
    });
    expect(out.branch).toBe(BRANCH);
    expect(out.headSha).toBe(head);

    await git(['checkout', '-q', '--detach', 'HEAD'], worktree);
    const detached = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      devicePubkeyBase64: dev,
    });
    expect(detached.ran).toBe(false);
    await git(['checkout', '-q', BRANCH], worktree);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(head);
  });
});
