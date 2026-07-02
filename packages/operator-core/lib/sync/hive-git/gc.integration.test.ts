/**
 * gc.integration.test.ts — bounded hive-git namespace retention against a REAL
 * temp bare repo (git on PATH, no network).
 *
 * Proves: per-namespace retention keeps work + sigrefs + newest published refs,
 * removes older refs without losing staging-reachable objects, and archives a
 * departed namespace before pruning it from the live namespace tree.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/gc.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { defaultRunGit, ensureHiveGitRepo, writeNamespaceRef, deviceNamespaceKey } from './storage';
import { SIGREFS_REF } from './sigrefs';
import { STAGING_REF, WORK_REF } from './integrator';
import { archiveNamespace, gcHiveGitRepo } from './gc';

function dev(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function commit(repo: string, files: Record<string, string>, parent?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'gc-commit-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'gc'];
    if (parent) args.push('-p', parent);
    const out = await defaultRunGit(args, repo);
    expect(out.code, out.stderr).toBe(0);
    return out.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function hasObject(repo: string, sha: string): Promise<boolean> {
  const r = await defaultRunGit(['cat-file', '-e', sha], repo);
  return r.code === 0;
}

async function hasRef(repo: string, ref: string): Promise<boolean> {
  const r = await defaultRunGit(['show-ref', '--verify', '--quiet', ref], repo);
  return r.code === 0;
}

describe('hive-git gc (real bare repo)', () => {
  let root: string;
  let repo: string;
  const memberA = dev();
  const memberB = dev();
  const integrator = dev();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hivegit-gc-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensureHiveGitRepo('hive-gc', 'repo-1');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('keeps work + sigrefs + newest published refs while pruning old refs safely', async () => {
    const base = await commit(repo, { 'f.txt': '0' });
    const c1 = await commit(repo, { 'f.txt': '1' }, base);
    const c2 = await commit(repo, { 'f.txt': '2' }, c1);
    const c3 = await commit(repo, { 'f.txt': '3' }, c2);
    const work = await commit(repo, { 'f.txt': '4' }, c3);
    const orphan = await commit(repo, { 'orphan.txt': 'x' });
    await writeNamespaceRef(repo, memberA, 'refs/heads/publish-1', c1);
    await writeNamespaceRef(repo, memberA, 'refs/heads/publish-2', c2);
    await writeNamespaceRef(repo, memberA, 'refs/heads/publish-3', c3);
    await writeNamespaceRef(repo, memberA, 'refs/heads/publish-old', orphan);
    await writeNamespaceRef(repo, memberA, WORK_REF, work);
    await writeNamespaceRef(repo, memberA, SIGREFS_REF, work);
    await writeNamespaceRef(repo, integrator, STAGING_REF, c3);

    const result = await gcHiveGitRepo(repo, { keepPublishedRefsPerNamespace: 2 });
    expect(result.errors).toEqual([]);

    const memberHex = deviceNamespaceKey(memberA);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/refs/heads/publish-3`)).toBe(true);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/refs/heads/publish-2`)).toBe(true);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/refs/heads/publish-1`)).toBe(false);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/refs/heads/publish-old`)).toBe(false);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/${WORK_REF}`)).toBe(true);
    expect(await hasRef(repo, `refs/namespaces/${memberHex}/${SIGREFS_REF}`)).toBe(true);
    expect(await hasObject(repo, c1)).toBe(true); // still reachable through staging ancestry
    expect(await hasObject(repo, orphan)).toBe(false); // dropped ref and now unreachable
  });

  it('archives a departed namespace under refs/archive before deleting the live refs', async () => {
    const live = await commit(repo, { 'bye.txt': '1' });
    await writeNamespaceRef(repo, memberB, WORK_REF, live);
    await writeNamespaceRef(repo, memberB, 'refs/heads/publish-1', live);

    const archived = await archiveNamespace(repo, deviceNamespaceKey(memberB));
    expect(archived.errors).toEqual([]);

    const hex = deviceNamespaceKey(memberB);
    expect(await hasRef(repo, `refs/namespaces/${hex}/${WORK_REF}`)).toBe(false);
    expect(await hasRef(repo, `refs/namespaces/${hex}/refs/heads/publish-1`)).toBe(false);
    expect(await hasRef(repo, `refs/archive/namespaces/${hex}/${WORK_REF}`)).toBe(true);
    expect(await hasRef(repo, `refs/archive/namespaces/${hex}/refs/heads/publish-1`)).toBe(true);
  });
});
