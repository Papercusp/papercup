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
  changedFilesRecursive,
  changedFilesInSubmodule,
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

  it('does not treat a cross-repository SHA error as a normal negative result', async () => {
    const localHead = await commit('a.txt', '1', 'local');
    const foreignRepo = mkdtempSync(join(tmpdir(), 'relgit-foreign-'));
    try {
      await git(foreignRepo, ['init', '-q', '-b', 'main']);
      await git(foreignRepo, ['config', 'user.email', 'test@example.com']);
      await git(foreignRepo, ['config', 'user.name', 'Test']);
      await git(foreignRepo, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(foreignRepo, 'foreign.txt'), 'foreign');
      await git(foreignRepo, ['add', '-A']);
      await git(foreignRepo, ['commit', '--no-verify', '-q', '-m', 'foreign']);
      const foreignHead = await revParse(foreignRepo, 'HEAD');

      await expect(isAncestor(repo, foreignHead, localHead)).rejects.toMatchObject({ code: 128 });
    } finally {
      rmSync(foreignRepo, { recursive: true, force: true });
    }
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

// EI-19365565179927273. The same blind spot EI-856 hit for migrations, in a second
// consumer: the green-checkpoint skew detector matches failing TEST paths against the
// range diff, so a submodule-pinned test fix read as "presumptively a real red" and sent
// agents to re-diagnose 6 already-correct embedder tests. `changedFiles` alone can never
// see inside a gitlink, and this repo has 39 submodules.
describe('changedFilesRecursive — gitlink expansion', () => {
  /** Stand up a real repo at `mount` and pin the superproject's gitlink to it.
   *  (A plain local repo at the mount path — git-ops's helpers are `git -C <path>`
   *  wrappers, so no `git submodule` registration is needed, matching the fixture
   *  style already used by the migrationsBetween tests above.) */
  async function createSubmodule(mount: string): Promise<string> {
    const subRepo = join(repo, mount);
    mkdirSync(subRepo, { recursive: true });
    await git(subRepo, ['init', '-q', '-b', 'main']);
    await git(subRepo, ['config', 'user.email', 'test@example.com']);
    await git(subRepo, ['config', 'user.name', 'Test']);
    await git(subRepo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(subRepo, 'README.md'), 'sub');
    await git(subRepo, ['add', '-A']);
    await git(subRepo, ['commit', '--no-verify', '-q', '-m', 'sub-init']);
    const pin = await revParse(subRepo, 'HEAD');
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${pin},${mount}`]);
    await git(repo, ['commit', '--no-verify', '-q', '-m', `pin ${mount}`]);
    return subRepo;
  }

  /** Change a file inside an already-pinned submodule and re-pin the superproject. */
  async function bumpPin(mount: string, innerFile: string): Promise<void> {
    const subRepo = join(repo, mount);
    const full = join(subRepo, innerFile);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'expect(dims).toHaveLength(768);');
    await git(subRepo, ['add', '-A']);
    await git(subRepo, ['commit', '--no-verify', '-q', '-m', 'fix the test']);
    const pin = await revParse(subRepo, 'HEAD');
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${pin},${mount}`]);
    await git(repo, ['commit', '--no-verify', '-q', '-m', `bump ${mount}`]);
  }

  /** create + pin, then bump — the common single-submodule case. */
  async function bumpSubmodule(
    mount: string,
    innerFile: string,
  ): Promise<{ before: string; after: string; subRepo: string }> {
    const subRepo = await createSubmodule(mount);
    const before = await revParse(repo, 'HEAD');
    await bumpPin(mount, innerFile);
    const after = await revParse(repo, 'HEAD');
    return { before, after, subRepo };
  }

  it('expands a moved gitlink into its files, mount-prefixed — the case a plain diff cannot see', async () => {
    const { before, after } = await bumpSubmodule('libs/generic/memory', 'src/gemma-embedder.test.ts');

    // The bug, stated as an assertion: the superproject diff names ONLY the directory.
    expect(await changedFiles(repo, before, after)).toEqual(['libs/generic/memory']);

    const { files, unexpandedSubmodules } = await changedFilesRecursive(repo, before, after);
    expect(files).toContain('libs/generic/memory/src/gemma-embedder.test.ts');
    expect(unexpandedSubmodules).toEqual([]);
  });

  it('keeps the superproject files alongside the expanded ones', async () => {
    const { before } = await bumpSubmodule('libs/generic/memory', 'src/embedder-dims.test.ts');
    await commit('packages/operator-core/lib/adv-agent-detail.test.ts', 'x', 'superproject change');
    const after = await revParse(repo, 'HEAD');

    const { files } = await changedFilesRecursive(repo, before, after);
    expect(files).toContain('packages/operator-core/lib/adv-agent-detail.test.ts');
    expect(files).toContain('libs/generic/memory/src/embedder-dims.test.ts');
  });

  it('proves only committed deletions, including rename sources and moved-submodule files', async () => {
    const mount = 'libs/generic/memory';
    const subRepo = await createSubmodule(mount);
    await bumpPin(mount, 'src/removed.ts');
    await commit('old.ts', 'export const value = 1;', 'old source');
    const before = await revParse(repo, 'HEAD');
    await git(repo, ['mv', 'old.ts', 'new.ts']);
    await git(subRepo, ['rm', 'src/removed.ts']);
    await bumpPin(mount, 'src/added.ts');
    const after = await revParse(repo, 'HEAD');
    const deleted = await changedFilesRecursive(repo, before, after, { deletedOnly: true });
    expect(deleted).toEqual({
      files: ['old.ts', `${mount}/src/removed.ts`],
      unexpandedSubmodules: [],
    });
    const all = await changedFilesRecursive(repo, before, after);
    // The unchanged default is rename-aware, so this identical-content move
    // names its destination. Only deletedOnly also names the vanished source.
    expect(all.files).not.toContain(`${mount}/src/removed.ts`);
    expect(all.files).toContain(`${mount}/src/added.ts`);
    expect(all.files).toContain('new.ts');
    // Uncommitted loss is not a deletion proof.
    rmSync(join(repo, 'new.ts'));
    expect(await changedFilesRecursive(repo, before, after, { deletedOnly: true })).toEqual(deleted);
  });

  it('does not call additions in a newly pinned submodule deletions', async () => {
    const before = await commit('root.ts', 'export {};', 'root');
    await createSubmodule('libs/generic/memory');
    const after = await revParse(repo, 'HEAD');
    expect(await changedFilesRecursive(repo, before, after, { deletedOnly: true })).toEqual({
      files: [],
      unexpandedSubmodules: [],
    });
  });

  it('adds nothing when no gitlink moved (no false positives from unrelated submodules)', async () => {
    const { after } = await bumpSubmodule('libs/generic/memory', 'src/a.test.ts');
    await commit('apps/operator/lib/x.ts', 'x', 'superproject only');
    const later = await revParse(repo, 'HEAD');

    // Pin is identical either side, so the submodule's contents must not be re-reported.
    const { files, unexpandedSubmodules } = await changedFilesRecursive(repo, after, later);
    expect(files).toEqual(['apps/operator/lib/x.ts']);
    expect(unexpandedSubmodules).toEqual([]);
  });

  it('reports a moved-but-undiffable submodule as UNEXPANDED rather than silently clean', async () => {
    // The honesty leg. A pin that moved but whose objects are unreachable (a shallow
    // clone, an uninitialised submodule — here: the checkout removed entirely) must not
    // degrade to "nothing changed", because that is indistinguishable from a real red.
    const { before, after, subRepo } = await bumpSubmodule('libs/generic/memory', 'src/a.test.ts');
    rmSync(subRepo, { recursive: true, force: true });

    const { files, unexpandedSubmodules } = await changedFilesRecursive(repo, before, after);
    expect(unexpandedSubmodules).toEqual(['libs/generic/memory']);
    expect(files).toEqual(['libs/generic/memory']); // superproject view only — the gitlink
  });

  it('expands EVERY moved submodule, not just the first', async () => {
    // Both submodules must exist BEFORE the range opens, or the second one is an
    // ADDITION rather than a move — a different case, covered by the test below.
    await createSubmodule('libs/generic/memory');
    await createSubmodule('libs/test-config');
    const before = await revParse(repo, 'HEAD');
    await bumpPin('libs/generic/memory', 'src/a.test.ts');
    await bumpPin('libs/test-config', 'src/b.test.ts');
    const after = await revParse(repo, 'HEAD');

    const { files } = await changedFilesRecursive(repo, before, after);
    expect(files).toContain('libs/generic/memory/src/a.test.ts');
    expect(files).toContain('libs/test-config/src/b.test.ts');
  });

  it('treats a submodule ADDED in range as fully changed, not as absent', async () => {
    // Caught by the multi-submodule test above during development: the moved-pin filter
    // originally required the path to exist at `from`, so a newly-vendored submodule was
    // skipped entirely — putting its tests straight back in the blind spot this item is
    // about, reported as "not modified in range" i.e. presumptively a real red.
    await createSubmodule('libs/generic/memory');
    const before = await revParse(repo, 'HEAD');
    await createSubmodule('libs/test-config');
    await bumpPin('libs/test-config', 'src/brand-new.test.ts');
    const after = await revParse(repo, 'HEAD');

    const { files, unexpandedSubmodules } = await changedFilesRecursive(repo, before, after);
    expect(files).toContain('libs/test-config/src/brand-new.test.ts');
    expect(unexpandedSubmodules).toEqual([]);
  });

  it('ignores a submodule REMOVED in range (its files cannot exist at tip)', async () => {
    const { after: before } = await bumpSubmodule('libs/generic/memory', 'src/a.test.ts');
    await git(repo, ['rm', '-q', '--cached', 'libs/generic/memory']);
    await git(repo, ['commit', '--no-verify', '-q', '-m', 'drop submodule']);
    const after = await revParse(repo, 'HEAD');

    const { unexpandedSubmodules } = await changedFilesRecursive(repo, before, after);
    // Not an error and not "undetermined" — a test there cannot be failing at tip.
    expect(unexpandedSubmodules).toEqual([]);
  });

  it('changedFilesInSubmodule THROWS on an undiffable submodule instead of returning []', async () => {
    // Load-bearing asymmetry: migrationsBetween wants to degrade silently, but
    // changedFilesRecursive must be able to TELL a failure from a genuinely empty diff —
    // a swallowed [] here is exactly the false confidence this whole item is about.
    const { before, after, subRepo } = await bumpSubmodule('libs/generic/memory', 'src/a.test.ts');
    rmSync(subRepo, { recursive: true, force: true });

    await expect(
      changedFilesInSubmodule(repo, before, after, 'libs/generic/memory'),
    ).rejects.toThrow();
  });

  it('returns [] (not a throw) for a submodule whose pin genuinely did not move', async () => {
    const { after } = await bumpSubmodule('libs/generic/memory', 'src/a.test.ts');
    await commit('apps/operator/lib/x.ts', 'x', 'superproject only');
    const later = await revParse(repo, 'HEAD');

    await expect(
      changedFilesInSubmodule(repo, after, later, 'libs/generic/memory'),
    ).resolves.toEqual([]);
  });
});
