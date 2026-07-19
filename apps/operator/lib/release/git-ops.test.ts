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
  commitShasBetween,
  submodulePins,
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

  // EI-14601: commitShasBetween gives the FULL-length sha of every commit in the
  // range (not just the tip) — this is what lets the deploy emitter fire the
  // per-sha awaitable key for every commit a batched fast-forward actually landed,
  // not only `targetSha`. `--oneline`'s abbreviated shas (commitsBetween) can't be
  // used for this: they're not guaranteed to line up with the full sha a caller
  // awaits.
  it('commitShasBetween returns every full-length commit sha in the range (not just the tip), oldest excluded from', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    const c2 = await commit('package-lock.json', '{}', 'lock');
    const c3 = await commit('libs/papercusp/libs/db/sql/200-thing.sql', 'SELECT 1;', 'mig');
    const c4 = await commit('apps/operator/lib/x.ts', 'x', 'code');

    const shas = await commitShasBetween(repo, c1, c4);
    expect(shas).toHaveLength(3); // c2, c3, c4 — c1 itself is the exclusive `from`
    expect(shas).toContain(c2);
    expect(shas).toContain(c3);
    expect(shas).toContain(c4);
    expect(shas.every((s) => /^[0-9a-f]{40}$/.test(s))).toBe(true); // full-length, not abbreviated

    expect(await commitShasBetween(repo, null, c4)).toEqual([]);
  });

  // EI-856: a migration landing entirely inside the `libs/papercusp` SUBMODULE
  // used to be invisible here — the superproject diff only ever sees the
  // gitlink pointer move, never the `.sql` path itself, so `migrationsBetween`
  // silently reported `[]` for a real migration. This is the load-bearing
  // regression: `deploy.ts` gates `rollback-db` (restoreSnapshot) on
  // `plan.migrations.length > 0`, so a submodule-only migration both
  // under-reported the plan AND silently disabled the DB-rollback safety net.
  it('migrationsBetween detects a migration landing ONLY inside the libs/papercusp submodule (gitlink-only superproject diff)', async () => {
    // A real, standalone git repo standing in for the `libs/papercusp` submodule,
    // checked out at the exact path the superproject mounts it at — git-ops's
    // helpers are plain `git -C <path> ...` wrappers, so this needs no actual
    // `git submodule` registration to exercise (avoids depending on the host's
    // submodule/protocol policy for a local-path `submodule add`).
    const subRepo = join(repo, 'libs/papercusp');
    mkdirSync(subRepo, { recursive: true });
    await git(subRepo, ['init', '-q', '-b', 'main']);
    await git(subRepo, ['config', 'user.email', 'test@example.com']);
    await git(subRepo, ['config', 'user.name', 'Test']);
    await git(subRepo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(subRepo, 'README.md'), 'sub');
    await git(subRepo, ['add', '-A']);
    await git(subRepo, ['commit', '--no-verify', '-q', '-m', 'sub-init']);
    const subPin1 = await revParse(subRepo, 'HEAD');

    // Pin the superproject's gitlink to the submodule's FIRST commit — via
    // `update-index --cacheinfo`, the same mechanism `git submodule add` uses
    // under the hood, without needing the submodule machinery itself.
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${subPin1},libs/papercusp`]);
    await git(repo, ['commit', '--no-verify', '-q', '-m', 'pin submodule @ init']);
    const c1 = await revParse(repo, 'HEAD');

    // The migration lands ENTIRELY inside the submodule — the superproject
    // commit only ever re-points the gitlink, never touches a .sql path.
    mkdirSync(join(subRepo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(subRepo, 'libs/db/sql/300-thing.sql'), 'SELECT 1;');
    await git(subRepo, ['add', '-A']);
    await git(subRepo, ['commit', '--no-verify', '-q', '-m', 'sub-migration']);
    const subPin2 = await revParse(subRepo, 'HEAD');
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${subPin2},libs/papercusp`]);
    await git(repo, ['commit', '--no-verify', '-q', '-m', 'bump submodule pin']);
    const c2 = await revParse(repo, 'HEAD');

    // The superproject's OWN diff sees only the gitlink move, never the .sql path.
    const superprojectFiles = await changedFiles(repo, c1, c2);
    expect(superprojectFiles).toEqual(['libs/papercusp']);

    // submodulePins correctly reads the two distinct pins either side of the bump.
    expect((await submodulePins(repo, c1)).get('libs/papercusp')).toBe(subPin1);
    expect((await submodulePins(repo, c2)).get('libs/papercusp')).toBe(subPin2);

    // migrationsBetween now finds it via the submodule's own history.
    const migs = await migrationsBetween(repo, c1, c2);
    expect(migs).toEqual(['libs/papercusp/libs/db/sql/300-thing.sql']);
  });

  it('migrationsBetween with an unchanged submodule pin adds nothing (no false positive)', async () => {
    const subRepo = join(repo, 'libs/papercusp');
    mkdirSync(subRepo, { recursive: true });
    await git(subRepo, ['init', '-q', '-b', 'main']);
    await git(subRepo, ['config', 'user.email', 'test@example.com']);
    await git(subRepo, ['config', 'user.name', 'Test']);
    await git(subRepo, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(subRepo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(subRepo, 'libs/db/sql/100-existing.sql'), 'SELECT 1;');
    await git(subRepo, ['add', '-A']);
    await git(subRepo, ['commit', '--no-verify', '-q', '-m', 'sub-init']);
    const subPin = await revParse(subRepo, 'HEAD');
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${subPin},libs/papercusp`]);
    await git(repo, ['commit', '--no-verify', '-q', '-m', 'pin submodule']);
    const c1 = await revParse(repo, 'HEAD');
    // A superproject-only change — the submodule pin never moves.
    await commit('apps/operator/lib/x.ts', 'x', 'unrelated code change');
    const c2 = await revParse(repo, 'HEAD');

    const migs = await migrationsBetween(repo, c1, c2);
    expect(migs).toEqual([]); // the submodule's pre-existing migration is NOT re-reported
  });
});
