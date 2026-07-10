import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultRunGit } from './pot-git/storage';
import { advanceWorktree } from './pot-git/worktree-advance';

async function git(args: string[], cwd: string) {
  const result = await defaultRunGit(args, cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function writeRepoFiles(repoPath: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(repoPath, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

async function commit(repoPath: string, message: string, files: Record<string, string>) {
  await writeRepoFiles(repoPath, files);
  await git(['add', '.'], repoPath);
  await git(['commit', '-qm', message], repoPath);
  return git(['rev-parse', 'HEAD'], repoPath);
}

async function currentHead(repoPath: string) {
  const result = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoPath);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function createRepoPair() {
  const root = await mkdtemp(join(tmpdir(), 'worktree-advance-'));
  const source = join(root, 'source');
  const receiver = join(root, 'receiver');
  await git(['init', '-q', source], root);
  await git(['config', 'user.name', 'test'], source);
  await git(['config', 'user.email', 'test@example.com'], source);
  await commit(source, 'base', { 'a.txt': 'base\n' });
  await git(['clone', '-q', source, receiver], root);
  await git(['config', 'user.name', 'test'], receiver);
  await git(['config', 'user.email', 'test@example.com'], receiver);
  return { root, source, receiver };
}

describe('advanceWorktree (real git worktree)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('fast-forwards a clean receiver to the fetched target', async () => {
    const { root, source, receiver } = await createRepoPair();
    roots.push(root);
    const target = await commit(source, 'advance', { 'a.txt': 'advanced\n', 'b.txt': 'new\n' });
    await git(['fetch', '-q', 'origin'], receiver);

    const result = await advanceWorktree(receiver, target);

    expect(result).toMatchObject({ outcome: 'advanced', to: target });
    expect(await currentHead(receiver)).toBe(target);
    expect(await git(['show', 'HEAD:a.txt'], receiver)).toBe('advanced');
    expect(await git(['show', 'HEAD:b.txt'], receiver)).toBe('new');
  });

  it('defers instead of clobbering when dirty files overlap the incoming change', async () => {
    const { root, source, receiver } = await createRepoPair();
    roots.push(root);
    const base = await currentHead(receiver);
    const target = await commit(source, 'touch a', { 'a.txt': 'remote\n' });
    await writeFile(join(receiver, 'a.txt'), 'local dirty\n', 'utf8');
    await git(['fetch', '-q', 'origin'], receiver);

    const result = await advanceWorktree(receiver, target);

    expect(result.outcome).toBe('deferred-dirty');
    expect(result.dirtyOverlap).toContain('a.txt');
    expect(await currentHead(receiver)).toBe(base);
    expect(await git(['status', '--short', '--', 'a.txt'], receiver)).toBe('M a.txt');
  });

  it('still advances when local dirt is disjoint from the incoming paths', async () => {
    const { root, source, receiver } = await createRepoPair();
    roots.push(root);
    const target = await commit(source, 'touch b', { 'a.txt': 'base\n', 'b.txt': 'remote-only\n' });
    await writeFile(join(receiver, 'notes.md'), 'keep me\n', 'utf8');
    await git(['fetch', '-q', 'origin'], receiver);

    const result = await advanceWorktree(receiver, target);

    expect(result.outcome).toBe('advanced');
    expect(await currentHead(receiver)).toBe(target);
    expect(await git(['status', '--short', '--', 'notes.md'], receiver)).toBe('?? notes.md');
    expect(await git(['show', 'HEAD:b.txt'], receiver)).toBe('remote-only');
  });

  it('refuses a diverged target and leaves the local head alone', async () => {
    const { root, source, receiver } = await createRepoPair();
    roots.push(root);
    const base = await currentHead(receiver);
    const target = await commit(source, 'remote advance', { 'a.txt': 'remote\n' });
    await commit(receiver, 'local advance', { 'a.txt': 'base\n', 'local.txt': 'mine\n' });
    await git(['fetch', '-q', 'origin'], receiver);

    const result = await advanceWorktree(receiver, target);

    expect(result.outcome).toBe('diverged-manual');
    expect(result.from).not.toBe(base);
    expect(await currentHead(receiver)).toBe(result.from);
    expect(await git(['show', 'HEAD:local.txt'], receiver)).toBe('mine');
  });
});
