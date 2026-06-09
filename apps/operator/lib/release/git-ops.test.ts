/**
 * Tests for the release-gating git primitives. Spin up real throwaway repos —
 * the FF invariant is load-bearing (a bad advance would deploy the wrong code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  git,
  revParse,
  refExists,
  isAncestor,
  advanceReady,
  changedFiles,
  migrationsBetween,
  commitsBetween,
} from './git-ops';

let repo: string;

async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(repo, 'HEAD');
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'relgit-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('advanceReady — the FF invariant', () => {
  it('creates ready when absent', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    expect(await refExists(repo, 'ready')).toBe(false);
    const r = await advanceReady(repo, 'main');
    expect(r).toMatchObject({ advanced: true, from: null, to: c1, reason: 'created' });
    expect(await revParse(repo, 'ready')).toBe(c1);
  });

  it('fast-forwards ready to a descendant', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await advanceReady(repo, 'main'); // ready=c1
    const c2 = await commit('a.txt', '2', 'c2');
    const r = await advanceReady(repo, 'main');
    expect(r).toMatchObject({ advanced: true, from: c1, to: c2, reason: 'fast-forwarded' });
    expect(await revParse(repo, 'ready')).toBe(c2);
  });

  it('is a no-op when ready already at candidate', async () => {
    await commit('a.txt', '1', 'c1');
    await advanceReady(repo, 'main');
    const r = await advanceReady(repo, 'main');
    expect(r.advanced).toBe(false);
    expect(r.reason).toBe('already-at-candidate');
  });

  it('refuses a non-fast-forward (never rewinds/diverges ready)', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    // ready advances to a feature commit, then candidate diverges from c1
    const cFeat = await commit('a.txt', 'feat', 'feat');
    await advanceReady(repo, cFeat); // ready=cFeat
    // rewind main to c1 and make a divergent commit
    await git(repo, ['reset', '--hard', c1]);
    const cDiv = await commit('b.txt', 'div', 'div');
    const r = await advanceReady(repo, cDiv);
    expect(r).toMatchObject({ advanced: false, reason: 'not-fast-forward' });
    expect(await revParse(repo, 'ready')).toBe(cFeat); // unchanged
  });
});

describe('isAncestor', () => {
  it('detects ancestry both directions', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    const c2 = await commit('a.txt', '2', 'c2');
    expect(await isAncestor(repo, c1, c2)).toBe(true);
    expect(await isAncestor(repo, c2, c1)).toBe(false);
    expect(await isAncestor(repo, c1, c1)).toBe(true);
  });
});

describe('diff helpers', () => {
  it('changedFiles + migrationsBetween + commitsBetween', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await commit('package-lock.json', '{}', 'lock');
    await commit('libs/papercusp/libs/db/sql/200-thing.sql', 'SELECT 1;', 'mig');
    const c4 = await commit('apps/operator/lib/x.ts', 'x', 'code');

    const files = await changedFiles(repo, c1, c4);
    expect(files).toContain('package-lock.json');
    expect(files).toContain('libs/papercusp/libs/db/sql/200-thing.sql');

    const migs = await migrationsBetween(repo, c1, c4);
    expect(migs).toEqual(['libs/papercusp/libs/db/sql/200-thing.sql']);

    const commits = await commitsBetween(repo, c1, c4);
    expect(commits.length).toBe(3); // lock, mig, code
    expect(await commitsBetween(repo, null, c4)).toEqual([]);
  });
});
