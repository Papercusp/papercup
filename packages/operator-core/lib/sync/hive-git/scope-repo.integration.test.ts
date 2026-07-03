/**
 * scope-repo integration — ensureScopeRepo against real git in a temp root
 * (the storage.ts integration pattern: env-pinned hive-git root, no swarm).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureScopeRepo, scopeRepoPath, type ScopeId } from './scope-repo';
import { defaultRunGit } from './storage';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'demo' };

let root: string;
let oldRoot: string | undefined;

beforeAll(async () => {
  oldRoot = process.env.PAPERCUSP_HIVE_GIT_ROOT;
  root = await mkdtemp(join(tmpdir(), 'scope-repo-it-'));
  process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
});

afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  else process.env.PAPERCUSP_HIVE_GIT_ROOT = oldRoot;
  await rm(root, { recursive: true, force: true });
});

describe('ensureScopeRepo', () => {
  it('creates a real bare repo at the FS-D3 path and is idempotent', async () => {
    const p1 = await ensureScopeRepo('papercusp', SCOPE);
    expect(p1).toBe(scopeRepoPath('papercusp', SCOPE));
    await access(join(p1, 'HEAD')); // a bare repo has HEAD at its root

    // Idempotent: second call returns the same path without re-init damage.
    const p2 = await ensureScopeRepo('papercusp', SCOPE);
    expect(p2).toBe(p1);

    // It is a usable bare repo: rev-parse succeeds inside it.
    const r = await defaultRunGit(['rev-parse', '--is-bare-repository'], p1);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  it('keeps sibling scopes in separate repos (structural isolation)', async () => {
    const other: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'other' };
    const p = await ensureScopeRepo('papercusp', other);
    expect(p).not.toBe(scopeRepoPath('papercusp', SCOPE));
    await access(join(p, 'HEAD'));
  });
});
