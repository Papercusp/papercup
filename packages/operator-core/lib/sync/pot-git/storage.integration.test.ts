/**
 * storage.integration.test.ts — the G-1 hive-git store against a REAL temp bare
 * repo (git on PATH, no network). Proves the per-device-namespace + shared-ODB
 * model end to end: init, write/read/delete namespaced refs, list namespaces +
 * their refs, the device→hex namespace mapping, and the path-safety guards.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/storage.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  defaultRunGit,
  potGitRoot,
  hiveGitRepoPath,
  deviceNamespaceKey,
  namespaceRefPath,
  ensurePotGitRepo,
  writeNamespaceRef,
  readNamespaceRef,
  deleteNamespaceRef,
  listNamespaces,
  listNamespaceRefs,
} from './storage';

/** A raw-32 Ed25519 pubkey as base64 (the wire form). */
function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Mint a real commit with no stdin dependency: empty tree → commit-tree. */
async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const emptyTree = tree.stdout.trim();
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', emptyTree, '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('hive-git storage (real bare repo)', () => {
  let root: string;
  let repoPath: string;
  const devA = devicePubkey();
  const devB = devicePubkey();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hivegit-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repoPath = await ensurePotGitRepo('my-hive', 'repo-42');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('ensurePotGitRepo makes a bare repo at the (hive, repo) path; idempotent', async () => {
    expect(repoPath).toBe(hiveGitRepoPath('my-hive', 'repo-42'));
    expect(repoPath.startsWith(potGitRoot())).toBe(true);
    const again = await ensurePotGitRepo('my-hive', 'repo-42'); // no throw, same path
    expect(again).toBe(repoPath);
    const head = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoPath);
    expect(head.stdout.trim()).toBe('true');
  });

  it('uses distinct bare repos for different repo keys under the same hive', async () => {
    const repoA = await ensurePotGitRepo('my-hive', 'repo-a');
    const repoB = await ensurePotGitRepo('my-hive', 'repo-b');
    expect(repoA).toBe(hiveGitRepoPath('my-hive', 'repo-a'));
    expect(repoB).toBe(hiveGitRepoPath('my-hive', 'repo-b'));
    expect(repoA).not.toBe(repoB);
    const headA = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoA);
    const headB = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoB);
    expect(headA.stdout.trim()).toBe('true');
    expect(headB.stdout.trim()).toBe('true');
  });

  it('deviceNamespaceKey is raw-32 → 64 hex; namespaceRefPath composes; rejects bad input', () => {
    const hex = deviceNamespaceKey(devA);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(namespaceRefPath(devA, 'refs/heads/work')).toBe(`refs/namespaces/${hex}/refs/heads/work`);
    expect(() => deviceNamespaceKey('too-short')).toThrow(/raw-32/);
    expect(() => namespaceRefPath(devA, 'heads/work')).toThrow(/refs\//);
  });

  it('path-safety guards reject traversal in hive slug / repo key', () => {
    expect(() => hiveGitRepoPath('../evil', 'r')).toThrow(/unsafe/);
    expect(() => hiveGitRepoPath('h', 'a/b')).toThrow(/unsafe/);
    expect(() => hiveGitRepoPath('h', '..')).toThrow(/unsafe/);
  });

  it('write → read a namespaced ref; a missing ref reads null', async () => {
    const sha = await mintCommit(repoPath, 'A work 1');
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBeNull();
    await writeNamespaceRef(repoPath, devA, 'refs/heads/work', sha);
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBe(sha);
  });

  it('each device writes ONLY its own namespace; the ODB is shared (same sha, one store)', async () => {
    const shaA = await mintCommit(repoPath, 'A work 2');
    const shaB = await mintCommit(repoPath, 'B work 1');
    await writeNamespaceRef(repoPath, devA, 'refs/heads/work', shaA);
    await writeNamespaceRef(repoPath, devB, 'refs/heads/work', shaB);
    // Same ref name, different namespaces → no collision.
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBe(shaA);
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/work')).toBe(shaB);
    // Both objects live in the ONE shared ODB of this bare repo.
    for (const s of [shaA, shaB]) {
      const cat = await defaultRunGit(['cat-file', '-e', s], repoPath);
      expect(cat.code).toBe(0);
    }
  });

  it('listNamespaces enumerates both devices; listNamespaceRefs strips the prefix', async () => {
    const ns = await listNamespaces(repoPath);
    expect(ns).toContain(deviceNamespaceKey(devA));
    expect(ns).toContain(deviceNamespaceKey(devB));
    await writeNamespaceRef(repoPath, devA, 'refs/rad/sigrefs', await mintCommit(repoPath, 'A sig'));
    const refs = await listNamespaceRefs(repoPath, devA);
    const names = refs.map((r) => r.ref);
    expect(names).toContain('refs/heads/work');
    expect(names).toContain('refs/rad/sigrefs');
    expect(names.every((n) => n.startsWith('refs/'))).toBe(true); // prefix stripped, normal ref names
  });

  it('CAS write refuses a stale expectedOld; delete is idempotent', async () => {
    const s1 = await mintCommit(repoPath, 'cas 1');
    const s2 = await mintCommit(repoPath, 'cas 2');
    await writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s1);
    // wrong expectedOld → rejected
    await expect(writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s2, defaultRunGit, s2)).rejects.toThrow();
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBe(s1);
    // correct expectedOld → moves
    await writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s2, defaultRunGit, s1);
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBe(s2);
    // delete, then delete again (idempotent)
    await deleteNamespaceRef(repoPath, devB, 'refs/heads/cas');
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBeNull();
    await deleteNamespaceRef(repoPath, devB, 'refs/heads/cas'); // no throw
  });
});
