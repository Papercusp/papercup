// dev-deploy-state — the read-only release-gate snapshot (plan
// dev-admin-sidebar-2026-06-05, P-006). Exercises the real git logic against a
// throwaway integration repo + a release worktree, driven through the same env
// seams (PAPERCUSP_INTEGRATION_ROOT / _RELEASE_ROOT / _RELEASE_REF / _BRANCH)
// the live host sets, so the "N commits behind main" maths is verified end-to-end.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { devDeployState, resetDevDeployStateCache } from './dev-deploy-state';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function commit(repo: string, file: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), msg);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

let tmp: string;
let integration: string;
let release: string;
let shaA = '';
let shaB = '';
let shaC = '';
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeploy-'));
  integration = path.join(tmp, 'papercup');
  release = path.join(tmp, 'papercup-release');
  execFileSync('git', ['init', '-q', '-b', 'main', integration]);

  // main: A → B → C (three commits, newest C).
  shaA = commit(integration, 'f', 'A');
  shaB = commit(integration, 'f', 'B');
  // `ready` pinned at B (1 commit behind main's C).
  git(integration, ['branch', 'ready', shaB]);
  shaC = commit(integration, 'f', 'C');

  // The release checkout (what :3070 runs) deployed at A — a worktree sharing
  // the object store, detached at A (2 behind main, 1 behind ready).
  git(integration, ['worktree', 'add', '-q', '--detach', release, shaA]);
});

afterAll(() => {
  try {
    git(integration, ['worktree', 'remove', '--force', release]);
  } catch {
    /* best effort */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeAll(() => {
  for (const k of [
    'PAPERCUSP_INTEGRATION_ROOT',
    'PAPERCUSP_RELEASE_ROOT',
    'PAPERCUSP_RELEASE_REF',
    'PAPERCUSP_INTEGRATION_BRANCH',
    'PAPERCUSP_DEPLOY_STATE_TTL_MS',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.PAPERCUSP_INTEGRATION_ROOT = integration;
  process.env.PAPERCUSP_RELEASE_ROOT = release;
  process.env.PAPERCUSP_RELEASE_REF = 'ready';
  process.env.PAPERCUSP_INTEGRATION_BRANCH = 'main';
  // These tests mutate refs/env then re-read, so disable the snapshot cache;
  // the caching behaviour itself is covered by its own describe block below.
  process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
});

afterEach(() => {
  resetDevDeployStateCache();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('devDeployState', () => {
  it('resolves main / ready / deployed refs from the env-seamed checkouts', async () => {
    const st = await devDeployState();
    expect(st.errors).toEqual([]);
    expect(st.integrationBranch).toBe('main');
    expect(st.releaseRef).toBe('ready');
    expect(st.mainHead?.sha).toBe(shaC);
    expect(st.ready?.sha).toBe(shaB);
    expect(st.deployed?.sha).toBe(shaA);
  });

  it('computes the "behind" distances correctly', async () => {
    const st = await devDeployState();
    // main = A→B→C. deployed=A → 2 behind main (B, C). ready=B → 1 behind main (C).
    expect(st.deployedBehindMain).toBe(2);
    expect(st.readyBehindMain).toBe(1);
    // deployed=A is 1 behind ready=B → there's a green commit deployable but undeployed.
    expect(st.deployedBehindReady).toBe(1);
    // ready (B) is NOT at main HEAD (C) → there's a staging buffer.
    expect(st.readyAtMainHead).toBe(false);
  });

  it('carries commit subjects + a short sha for display', async () => {
    const st = await devDeployState();
    expect(st.mainHead?.subject).toBe('C');
    expect(st.deployed?.subject).toBe('A');
    expect(st.deployed?.shortSha).toBe(shaA.slice(0, 8));
    expect(typeof st.deployed?.committedAtMs).toBe('number');
  });

  it('reports readyAtMainHead=true once ready fast-forwards to main HEAD', async () => {
    git(integration, ['branch', '-f', 'ready', shaC]);
    try {
      const st = await devDeployState();
      expect(st.ready?.sha).toBe(shaC);
      expect(st.readyBehindMain).toBe(0);
      expect(st.readyAtMainHead).toBe(true);
    } finally {
      git(integration, ['branch', '-f', 'ready', shaB]); // restore for other tests
    }
  });

  it('deployedAtMs reflects a checkout INSIDE the linked worktree, not the worktree-creation mtime (WI-1623)', async () => {
    // The release checkout is `git worktree add`-ed once in beforeAll (creation
    // time long past); the worktree-root `.git` pointer FILE's mtime never
    // changes again. A real deploy runs `git checkout <sha>` inside that
    // worktree — assert deployedAtMs tracks THAT, not the pointer file.
    const gitFile = path.join(release, '.git');
    const gitFileMtimeBefore = fs.statSync(gitFile).mtimeMs;

    resetDevDeployStateCache();
    const before = await devDeployState();
    // Sanity: deployed currently resolves to A (the worktree-creation checkout).
    expect(before.deployed?.sha).toBe(shaA);

    // Simulate a deploy: checkout a different commit inside the worktree.
    // Bump the mtime clock forward so a coarse filesystem timestamp
    // resolution can't make this a no-op assertion.
    await new Promise((r) => setTimeout(r, 1100));
    git(release, ['checkout', '-q', '--detach', shaB]);

    resetDevDeployStateCache();
    const after = await devDeployState();
    expect(after.deployed?.sha).toBe(shaB);
    expect(after.deployedAtMs).not.toBeNull();
    // The bug: deployedAtMs used to equal the STATIC pointer file's mtime,
    // which the checkout above never touches.
    expect(after.deployedAtMs).toBeGreaterThan(gitFileMtimeBefore);
    // And it must be close to "now" (the checkout we just ran), not the
    // worktree's original creation time from beforeAll.
    expect(Date.now() - (after.deployedAtMs as number)).toBeLessThan(15_000);
  });

  it('populates errors[] (not throws) when a ref is missing, still returning a snapshot', async () => {
    const prev = process.env.PAPERCUSP_RELEASE_REF;
    process.env.PAPERCUSP_RELEASE_REF = 'no-such-ref';
    try {
      const st = await devDeployState();
      expect(st.ready).toBeNull();
      expect(st.errors.some((e) => e.includes('no-such-ref'))).toBe(true);
      // main + deployed still resolve — the snapshot is partial, not absent.
      expect(st.mainHead?.sha).toBe(shaC);
    } finally {
      process.env.PAPERCUSP_RELEASE_REF = prev;
    }
  });
});

describe('devDeployState caching (P-015 — collapse the git fan-out under the poll storm)', () => {
  afterEach(() => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
    resetDevDeployStateCache();
  });

  it('single-flights a concurrent burst into one shared snapshot', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '5000';
    resetDevDeployStateCache();
    const [a, b, c] = await Promise.all([devDeployState(), devDeployState(), devDeployState()]);
    // Same in-flight promise → identical object: only ONE git fan-out ran.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.mainHead?.sha).toBe(shaC);
  });

  it('serves repeat reads from cache within the TTL, then recomputes after reset', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '5000';
    resetDevDeployStateCache();
    const first = await devDeployState();
    const cached = await devDeployState();
    expect(cached).toBe(first); // within TTL → cache hit, no recompute

    resetDevDeployStateCache();
    const fresh = await devDeployState();
    expect(fresh).not.toBe(first); // new compute → new object
    expect(fresh.mainHead?.sha).toBe(first.mainHead?.sha); // same underlying data
  });

  it('TTL=0 disables the cache (every call recomputes)', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
    resetDevDeployStateCache();
    const a = await devDeployState();
    const b = await devDeployState();
    expect(a).not.toBe(b);
    expect(a.deployed?.sha).toBe(b.deployed?.sha);
  });
});
