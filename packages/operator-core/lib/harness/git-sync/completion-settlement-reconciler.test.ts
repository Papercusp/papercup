import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  batchHeadBlobLookup,
  normalizeStoredSettlementManifest,
  reconcileProposedCompletionsAtCommit,
  residualPathsForCommit,
  type CompletionSettlementReconcilerDeps,
} from './completion-settlement-reconciler';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import {
  completionBlobHistoryContains,
  completionHeadBlobMap,
  createCompletionBlobHistoryReader,
  type HeadBlobResolution,
} from '../../agent-tools/work_items/completion-freshness';
import { isCompletionSettled } from '../../work-item-completion-authority';

const SHA = 'a'.repeat(40);
const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});
const manifest = {
  version: 1 as const,
  generation: 2,
  evidenceHash: 'b'.repeat(64),
  repositoryRoot: '/repo',
  headSha: 'c'.repeat(40),
  normalizedPaths: ['a.ts', 'nested/b.ts'],
  contentIdentity: [
    { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null },
    { path: 'nested/b.ts', workingTreeBlobSha: 'e'.repeat(40), headBlobSha: null },
  ],
};

/** Build a lookup result in the three-valued contract (WI-42441). */
const resolved = (sha: string): HeadBlobResolution => ({ status: 'resolved', sha });
const absent = (): HeadBlobResolution => ({ status: 'absent' });
const unresolvable = (reason: string): HeadBlobResolution => ({ status: 'unresolvable', reason });

describe('residualPathsForCommit', () => {
  it('settles only when every close-time blob is present in the exact commit', async () => {
    expect(
      await residualPathsForCommit(
        manifest,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('e'.repeat(40))],
          ]),
      ),
    ).toEqual([]);
  });

  it('reads identities from the emitted commit SHA, independent of later working-tree edits', async () => {
    const lookup = vi.fn(
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', resolved('e'.repeat(40))],
        ]),
    );
    const laterWorkingTreeIdentity = new Map([
      ['a.ts', resolved('f'.repeat(40))],
      ['nested/b.ts', resolved('f'.repeat(40))],
    ]);

    expect(await residualPathsForCommit(manifest, SHA, lookup)).toEqual([]);
    expect(lookup).toHaveBeenCalledWith('/repo', SHA, ['a.ts', 'nested/b.ts']);
    expect(laterWorkingTreeIdentity).not.toEqual(lookup.mock.results[0]?.value);
  });

  it('persists deterministic residue for partial and mismatched commits', async () => {
    expect(
      await residualPathsForCommit(
        manifest,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('f'.repeat(40))],
            ['nested/b.ts', absent()],
          ]),
      ),
    ).toEqual([
      { path: 'a.ts', reason: 'content-mismatch' },
      { path: 'nested/b.ts', reason: 'missing-from-commit' },
    ]);
  });

  // EI-24807349327024992: a whole-batch lookup failure (a 5s `git ls-tree` timeout under load)
  // measured nothing. It must not become a persisted `identity-unavailable` verdict on every
  // path — that kept a fully committed close `proposed` for ~3h. Undefined = skip, retry.
  // CONTROL: one path the lookup DID answer as unresolvable still yields a persisted residue,
  // so this cannot pass by returning undefined for everything.
  it('skips (undefined) when the exact-tree lookup is unavailable, but keeps per-path residue', async () => {
    expect(await residualPathsForCommit(manifest, SHA, () => undefined)).toBeUndefined();
    expect(
      await residualPathsForCommit(
        manifest,
        SHA,
        () => new Map([['a.ts', resolved('d'.repeat(40))], ['nested/b.ts', unresolvable('submodule unreadable')]]),
      ),
    ).toEqual([{ path: 'nested/b.ts', reason: 'identity-unavailable' }]);
  });

  /**
   * WI-42441 — the defect this contract exists to kill. An unreadable submodule and a
   * path the commit genuinely lacks used to arrive here as the SAME thing (absence from
   * the map), so a resolution failure was reported as `missing-from-commit` — which reads
   * as the closer's fault and sends them to re-commit work that is already committed.
   *
   * The CONTROL below is what makes this falsifiable: the two cases are asserted in ONE
   * test against the SAME path, so an implementation that collapses them cannot pass —
   * whichever single reason it picks, one of the two expectations fails.
   */
  it('separates an unreadable submodule from a path the commit really lacks', async () => {
    const reason = "submodule 'libs/papercusp' could not be read at abc123456789";
    const unreadable = await residualPathsForCommit(
      manifest,
      SHA,
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', unresolvable(reason)],
        ]),
    );
    // CONTROL: identical shape, the one difference being a tree that was actually read.
    const genuinelyMissing = await residualPathsForCommit(
      manifest,
      SHA,
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', absent()],
        ]),
    );

    expect(unreadable).toEqual([{ path: 'nested/b.ts', reason: 'identity-unavailable' }]);
    expect(genuinelyMissing).toEqual([{ path: 'nested/b.ts', reason: 'missing-from-commit' }]);
    expect(unreadable).not.toEqual(genuinelyMissing);
  });

  it('fails closed — never `missing-from-commit` — for a path the lookup did not answer at all', async () => {
    // A map that simply omits a requested path is an INCOMPLETE answer, not a verdict
    // that the commit lacks it. Absence must never be promoted to a finding about the tree.
    expect(await residualPathsForCommit(manifest, SHA, () => new Map([['a.ts', resolved('d'.repeat(40))]]))).toEqual([
      { path: 'nested/b.ts', reason: 'identity-unavailable' },
    ]);
  });
});

describe('completionBlobHistoryContains — exact path and repository proof', () => {
  it('settles a committed then superseded blob, but rejects ODB-only, other-path, and ignored blobs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-history-'));
    TEMP_ROOTS.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(root, 'superseded.ts'), 'export const value = "before";\n');
    writeFileSync(join(root, 'dirty.ts'), 'export const value = "before dirty";\n');
    writeFileSync(join(root, 'wrong-path.ts'), 'export const value = "before wrong path";\n');
    git('add', '--', '.gitignore', 'superseded.ts', 'dirty.ts', 'wrong-path.ts');
    git('commit', '-q', '-m', 'completion head');
    const closeHeadSha = git('rev-parse', 'HEAD');
    const supersededHeadSha = git('hash-object', 'superseded.ts');
    const dirtyHeadSha = git('hash-object', 'dirty.ts');
    const wrongPathHeadSha = git('hash-object', 'wrong-path.ts');

    writeFileSync(join(root, 'superseded.ts'), 'export const value = "close time";\n');
    const supersededSha = git('hash-object', 'superseded.ts');
    git('add', '--', 'superseded.ts');
    git('commit', '-q', '-m', 'commit close-time blob');
    writeFileSync(join(root, 'superseded.ts'), 'export const value = "later content";\n');

    writeFileSync(join(root, 'dirty.ts'), 'export const value = "ODB only";\n');
    const dirtyOnlySha = git('hash-object', '-w', 'dirty.ts');
    writeFileSync(join(root, 'dirty.ts'), 'export const value = "later dirty content";\n');

    writeFileSync(join(root, 'other-path.ts'), 'export const value = "other path only";\n');
    const otherPathSha = git('hash-object', '-w', 'other-path.ts');
    writeFileSync(join(root, 'wrong-path.ts'), 'export const value = "later wrong content";\n');
    writeFileSync(join(root, 'ignored.ts'), 'export const value = "ignored ODB only";\n');
    const ignoredSha = git('hash-object', '-w', 'ignored.ts');
    git('add', '-A', '--', 'superseded.ts', 'dirty.ts', 'wrong-path.ts', 'other-path.ts');
    git('commit', '-q', '-m', 'supersede and commit controls');
    const emittedSha = git('rev-parse', 'HEAD');

    const historyManifest = {
      ...manifest,
      repositoryRoot: root,
      headSha: closeHeadSha,
      normalizedPaths: ['superseded.ts', 'dirty.ts', 'wrong-path.ts', 'ignored.ts'],
      contentIdentity: [
        { path: 'superseded.ts', workingTreeBlobSha: supersededSha, headBlobSha: supersededHeadSha },
        { path: 'dirty.ts', workingTreeBlobSha: dirtyOnlySha, headBlobSha: dirtyHeadSha },
        { path: 'wrong-path.ts', workingTreeBlobSha: otherPathSha, headBlobSha: wrongPathHeadSha },
        { path: 'ignored.ts', workingTreeBlobSha: ignoredSha, headBlobSha: null },
      ],
    };

    expect(
      await residualPathsForCommit(
        historyManifest,
        emittedSha,
        completionHeadBlobMap,
        undefined,
        completionBlobHistoryContains,
      ),
    ).toEqual([
      { path: 'dirty.ts', reason: 'content-mismatch' },
      { path: 'wrong-path.ts', reason: 'content-mismatch' },
      { path: 'ignored.ts', reason: 'missing-from-commit' },
    ]);
    // WI-10004711: through the PRODUCTION working-tree reader, dirty.ts and wrong-path.ts are
    // stranded — their recorded blobs reached no commit and the working tree has moved on.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settlement = await reconcileProposedCompletionsAtCommit(
      emittedSha,
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: root },
      { sql: settlementSql({ updateHits: [true], manifest: historyManifest }), emit: settlementEmitMock() },
    );
    expect(settlement).toMatchObject({ inspected: 1, upgraded: [], residual: 3, unreadable: [], stranded: ['WI-42476'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('became unsettleable by waiting'));
    warn.mockRestore();
    expect(
      await completionBlobHistoryContains(root, closeHeadSha, emittedSha, 'ignored.ts', ignoredSha),
    ).toBe(false);
    expect(
      await completionBlobHistoryContains(root, '0'.repeat(40), emittedSha, 'superseded.ts', supersededSha),
    ).toBeUndefined();
  });

  it('reads superseded history from the commit-pinned submodule object database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-history-submodule-'));
    TEMP_ROOTS.push(root);
    const subRoot = join(root, 'modules', 'nested');
    mkdirSync(subRoot, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    const subGit = (...args: string[]) =>
      execFileSync('git', ['-C', subRoot, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    subGit('init', '-q');
    subGit('config', 'user.email', 'fixture@example.test');
    subGit('config', 'user.name', 'Settlement Fixture');
    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "before";\n');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'submodule base');
    const submoduleHeadSha = subGit('rev-parse', 'HEAD');
    writeFileSync(join(root, '.gitmodules'), '[submodule "nested"]\n\tpath = modules/nested\n\turl = ./nested.git\n');
    git('add', '--', '.gitmodules');
    git('update-index', '--add', '--cacheinfo', '160000,' + submoduleHeadSha + ',modules/nested');
    git('commit', '-q', '-m', 'add nested submodule');
    const closeHeadSha = git('rev-parse', 'HEAD');

    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "close time";\n');
    const supersededSha = subGit('hash-object', 'file.ts');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'commit close-time submodule blob');
    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "later content";\n');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'supersede submodule blob');
    const emittedSubmoduleSha = subGit('rev-parse', 'HEAD');
    git('update-index', '--cacheinfo', '160000,' + emittedSubmoduleSha + ',modules/nested');
    git('commit', '-q', '-m', 'advance submodule pointer');
    const emittedSha = git('rev-parse', 'HEAD');

    expect(
      await completionBlobHistoryContains(
        root,
        closeHeadSha,
        emittedSha,
        'modules/nested/file.ts',
        supersededSha,
      ),
    ).toBe(true);
  });

  // EI-24821039535031884: a git read that hits its deadline is 'unmeasured' (the caller
  // retries), never undefined (persisted residue). CONTROL: a git that exits non-zero is a
  // deterministic refusal and stays undefined, so only the timeout outcome flips the answer.
  // Both git reads are covered: the top-level path runs `git log` alone, and the nested path
  // runs the gitlink `ls-tree` first.
  it('answers unmeasured for a timed-out git read and undefined for a git that refuses', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'completion-history-fake-git-'));
    TEMP_ROOTS.push(bin);
    const slowGit = join(bin, 'slow-git');
    const refusingGit = join(bin, 'refusing-git');
    writeFileSync(slowGit, '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
    writeFileSync(refusingGit, '#!/bin/sh\nexit 128\n', { mode: 0o755 });
    const ask = (gitBinary: string, path: string) =>
      completionBlobHistoryContains(bin, 'a'.repeat(40), 'b'.repeat(40), path, 'c'.repeat(40), {
        gitBinary,
        timeoutMs: 200,
      });

    expect(await ask(slowGit, 'file.ts')).toBe('unmeasured');
    expect(await ask(refusingGit, 'file.ts')).toBeUndefined();
    expect(await ask(slowGit, 'dir/file.ts')).toBe('unmeasured');
    expect(await ask(refusingGit, 'dir/file.ts')).toBeUndefined();
  });

  // WI-10005357: a settlement pass resolved every declared path with its own `ls-tree`, per
  // side. The shared reader must give the SAME verdicts (superproject and submodule paths,
  // found and not found) while issuing one gitlink read per (repository, commit) once the
  // paths are announced. A git wrapper logs each real exec, so the counts are measured.
  it('a shared reader answers exactly like the unshared one with one gitlink read per commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-history-shared-'));
    TEMP_ROOTS.push(root);
    const subRoot = join(root, 'modules', 'nested');
    mkdirSync(join(root, 'dir', 'deeper'), { recursive: true });
    mkdirSync(join(root, 'other'), { recursive: true });
    mkdirSync(join(subRoot, 'src'), { recursive: true });
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
    for (const repo of [root, subRoot]) {
      run(repo, 'init', '-q');
      run(repo, 'config', 'user.email', 'fixture@example.test');
      run(repo, 'config', 'user.name', 'Settlement Fixture');
    }
    const superPaths = ['dir/a.ts', 'dir/b.ts', 'dir/deeper/c.ts', 'other/d.ts'];
    for (const path of superPaths) writeFileSync(join(root, path), `export const v = "${path} before";\n`);
    writeFileSync(join(subRoot, 'src', 'file.ts'), 'export const v = "sub before";\n');
    run(subRoot, 'add', '--', 'src/file.ts');
    run(subRoot, 'commit', '-q', '-m', 'submodule base');
    writeFileSync(join(root, '.gitmodules'), '[submodule "nested"]\n\tpath = modules/nested\n\turl = ./nested.git\n');
    run(root, 'add', '--', '.gitmodules', ...superPaths);
    run(root, 'update-index', '--add', '--cacheinfo', '160000,' + run(subRoot, 'rev-parse', 'HEAD') + ',modules/nested');
    run(root, 'commit', '-q', '-m', 'close head');
    const closeHeadSha = run(root, 'rev-parse', 'HEAD');

    // Commit a close-time blob for every path except other/d.ts, then supersede them all.
    const blobs = new Map<string, string>();
    for (const path of superPaths) {
      writeFileSync(join(root, path), `export const v = "${path} close time";\n`);
      blobs.set(path, run(root, 'hash-object', '-w', path));
    }
    run(root, 'add', '--', 'dir');
    run(root, 'commit', '-q', '-m', 'close-time blobs');
    writeFileSync(join(subRoot, 'src', 'file.ts'), 'export const v = "sub close time";\n');
    blobs.set('modules/nested/src/file.ts', run(subRoot, 'hash-object', 'src/file.ts'));
    run(subRoot, 'commit', '-q', '-am', 'submodule close time');
    for (const path of superPaths) writeFileSync(join(root, path), `export const v = "${path} later";\n`);
    writeFileSync(join(subRoot, 'src', 'file.ts'), 'export const v = "sub later";\n');
    run(subRoot, 'commit', '-q', '-am', 'submodule later');
    run(root, 'update-index', '--cacheinfo', '160000,' + run(subRoot, 'rev-parse', 'HEAD') + ',modules/nested');
    run(root, 'add', '--', ...superPaths);
    run(root, 'commit', '-q', '-m', 'supersede everything');
    const emittedSha = run(root, 'rev-parse', 'HEAD');

    const bin = mkdtempSync(join(tmpdir(), 'completion-history-counting-git-'));
    TEMP_ROOTS.push(bin);
    const log = join(bin, 'execs.log');
    const countingGit = join(bin, 'git');
    writeFileSync(countingGit, `#!/bin/sh\nprintf '%s\\n' "$3" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 });
    const lsTreeExecs = () => {
      try {
        return execFileSync('grep', ['-c', '^ls-tree$', log], { encoding: 'utf8' }).trim();
      } catch {
        return '0';
      }
    };
    const paths = [...blobs.keys()];
    const opts = { gitBinary: countingGit };

    const unshared: unknown[] = [];
    for (const path of paths) {
      unshared.push(await completionBlobHistoryContains(root, closeHeadSha, emittedSha, path, blobs.get(path)!, opts));
    }
    // Control: other/d.ts's close-time blob never reached a commit; the rest did.
    expect(unshared).toEqual([true, true, true, false, true]);
    const unsharedReads = Number(lsTreeExecs());
    rmSync(log, { force: true });

    const reader = createCompletionBlobHistoryReader();
    reader.hint(root, emittedSha, paths);
    reader.hint(root, closeHeadSha, paths);
    const shared = await Promise.all(
      paths.map((path) => reader.contains(root, closeHeadSha, emittedSha, path, blobs.get(path)!, opts)),
    );
    expect(shared).toEqual(unshared);
    // Unshared: one read per path per side, plus one per side at the submodule level (12).
    // Shared: one per side in the superproject, one per side in the submodule (4).
    expect(unsharedReads).toBe(12);
    expect(Number(lsTreeExecs())).toBe(4);
    expect(reader.gitlinkReads()).toBe(4);
  });

  it('a shared reader retries an unmeasured gitlink read, reuses settled ones, and shares one in flight', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'completion-history-reader-'));
    TEMP_ROOTS.push(bin);
    const refusingGit = join(bin, 'refusing-git');
    writeFileSync(refusingGit, '#!/bin/sh\nexit 128\n', { mode: 0o755 });
    const from = 'a'.repeat(40);
    const to = 'b'.repeat(40);
    const reads: Array<{ sha: string; prefixes: readonly string[] }> = [];
    const reader = createCompletionBlobHistoryReader(async (_root, sha, prefixes) => {
      reads.push({ sha, prefixes });
      if (reads.length === 1) return 'unmeasured';
      return new Map(prefixes.map((prefix) => [prefix, null] as const));
    });
    const ask = (path: string) => reader.contains(bin, from, to, path, 'c'.repeat(40), { gitBinary: refusingGit });

    // The first read timed out: nothing was learned, so nothing is kept.
    expect(await ask('dir/file.ts')).toBe('unmeasured');
    // Retried at both commits; the refusing `git log` then makes the verdict undefined.
    expect(await ask('dir/file.ts')).toBeUndefined();
    expect(reads.map((read) => read.sha)).toEqual([from, from, to]);
    // Settled answers are reused, and two concurrent asks under a new directory share a read.
    expect(await ask('dir/again.ts')).toBeUndefined();
    await Promise.all([ask('other/x.ts'), ask('other/y.ts')]);
    expect(reads.map((read) => read.sha)).toEqual([from, from, to, from, to]);
    expect(reader.gitlinkReads()).toBe(5);
  });
});

/**
 * `floorRejects` models the migration 972/1207 `downgrade_unproven_committed_close` trigger:
 * the UPDATE matches, but RETURNING reflects the row AFTER the trigger reverted 'committed' to
 * 'proposed'. A real DB does exactly this for an unproven identity, which is why a returned row
 * alone is not evidence of an upgrade (EI-24710716781971154).
 */
function settlementSql(options: {
  updateHits: boolean[];
  manifest?: unknown;
  treeStamp?: unknown;
  floorRejects?: boolean;
}) {
  let updateIndex = 0;
  const payload = {
    [TERMINAL_COMPLETION_EVIDENCE_KEY]: {
      settlementManifest: options.manifest ?? manifest,
      ...(options.treeStamp === undefined ? {} : { treeStamp: options.treeStamp }),
    },
  };
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('SELECT feature_id, harness_slug, payload')) {
      return [{ feature_id: 'WI-42476', harness_slug: 'papercusp', payload }];
    }
    if (query.includes('UPDATE harness_shared.work_items')) {
      return options.updateHits[updateIndex++]
        ? [{ feature_id: 'WI-42476', authority: options.floorRejects ? 'proposed' : 'committed' }]
        : [];
    }
    throw new Error(`unexpected SQL: ${query}`);
  }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return sql;
}

function settlementEmitMock() {
  return vi.fn<NonNullable<CompletionSettlementReconcilerDeps['emit']>>(async (opts) => ({
    ok: true,
    key: opts.key,
    woken: 0,
    notified: [],
    msgId: null,
    waiters: 0,
  }));
}

describe('reconcileProposedCompletionsAtCommit — liveness', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () =>
    new Map([
      ['a.ts', resolved('d'.repeat(40))],
      ['nested/b.ts', resolved('e'.repeat(40))],
    ]);

  it('reports progress once per candidate, including the inspected total', async () => {
    const onProgress = vi.fn();
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [true] }),
      lookup: matchingLookup,
      emit: settlementEmitMock(),
      onProgress,
    });

    expect(result.inspected).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 1, featureId: 'WI-42476' });
  });

  it('settles independent candidates concurrently and reports completed work', async () => {
    const payload = { [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: manifest } };
    // WI-10005285: the exact-tree read is now ONE call per pass, so the per-row stage whose
    // overlap this measures is the write.
    let active = 0;
    let peak = 0;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        return ['WI-FIRST', 'WI-SECOND'].map((feature_id) => ({ feature_id, harness_slug: 'papercusp', payload }));
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    const lookup = vi.fn(async () => matchingLookup());
    const onProgress = vi.fn();

    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql, lookup, emit: settlementEmitMock(), onProgress,
    });

    expect(peak).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ inspected: 2, upgraded: [], residual: 0, unreadable: [] });
    expect(onProgress.mock.calls.map(([progress]) => progress.completed)).toEqual([1, 2]);
  });

  it('writes nothing for a row whose exact-tree lookup returned nothing, and names it lookupUnavailable', async () => {
    const sql = settlementSql({ updateHits: [true] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: async () => undefined,
      emit: settlementEmitMock(),
    });

    expect(result).toMatchObject({
      inspected: 1,
      upgraded: [],
      residual: 0,
      unreadable: [],
      lookupUnavailable: ['WI-42476'],
    });
    expect(
      vi
        .mocked(sql)
        .mock.calls.some(([strings]) =>
          (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'),
        ),
    ).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).includes('exact-tree lookup') && String(line).includes('WI-42476'))).toBe(true);
  });

  // EI-24821039535031884: the per-path history read has the same 5s deadline. A timed-out
  // history read must skip the row exactly like a failed exact-tree lookup: no write.
  it('writes nothing for a row whose history read was unmeasured, and names it lookupUnavailable', async () => {
    const sql = settlementSql({ updateHits: [true] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const historyLookup = vi.fn(async () => 'unmeasured' as const);
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      // a.ts is committed at a later blob, so its proof needs the history read.
      lookup: () => new Map([['a.ts', resolved('f'.repeat(40))], ['nested/b.ts', resolved('e'.repeat(40))]]),
      historyLookup,
      emit: settlementEmitMock(),
    });

    expect(historyLookup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ inspected: 1, upgraded: [], residual: 0, unreadable: [], lookupUnavailable: ['WI-42476'] });
    expect(
      vi
        .mocked(sql)
        .mock.calls.some(([strings]) =>
          (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'),
        ),
    ).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).includes('history read') && String(line).includes('WI-42476'))).toBe(true);
    warn.mockRestore();
  });

  it('stops before a late settlement write when the action signal aborts', async () => {
    const controller = new AbortController();
    const sql = settlementSql({ updateHits: [true] });
    const lookup = vi.fn(async () => {
      controller.abort(new Error('settlement timeout'));
      return matchingLookup();
    });
    const onProgress = vi.fn();

    await expect(
      reconcileProposedCompletionsAtCommit(SHA, scope, {
        sql,
        lookup,
        emit: settlementEmitMock(),
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toThrow('settlement timeout');

    expect(
      vi
        .mocked(sql)
        .mock.calls.some(([strings]) =>
          (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'),
        ),
    ).toBe(false);
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 1, featureId: 'WI-42476' });
  });
});

describe('reconcileProposedCompletionsAtCommit — WI-1053550 treeStamp refresh', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () => new Map([
    ['a.ts', resolved('d'.repeat(40))],
    ['nested/b.ts', resolved('e'.repeat(40))],
  ]);

  it('refreshes treeStamp.contentIdentity so the upgrade proves under the migration-972 floor', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true] });

    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      treeStamp?: { headSha: string; repositoryRoot: string; contentIdentity: Array<{
        path: string; workingTreeBlobSha: string | null; headBlobSha: string | null;
      }> };
    };

    // This is the exact predicate migration 972's completion_authority_floor_trg
    // (and its TS mirror completionTreeContentIdentityMatches) requires — proving
    // it here is proving the upgrade this reconciler just wrote SURVIVES the trigger
    // instead of being downgraded straight back to 'proposed' on the same write.
    expect(evidence.treeStamp).toBeDefined();
    expect(evidence.treeStamp!.headSha).toBe(SHA);
    expect(evidence.treeStamp!.repositoryRoot).toBe(manifest.repositoryRoot);
    expect(evidence.treeStamp!.contentIdentity).toHaveLength(2);
    for (const entry of evidence.treeStamp!.contentIdentity) {
      expect(entry.workingTreeBlobSha).not.toBeNull();
      expect(entry.headBlobSha).toBe(entry.workingTreeBlobSha);
    }
  });

  it('writes a manifest-bound history attestation without rewriting truthful treeStamp', async () => {
    const originalTreeStamp = {
      repositoryRoot: manifest.repositoryRoot,
      headSha: manifest.headSha,
      contentIdentity: manifest.contentIdentity,
    };
    const sql = settlementSql({ updateHits: [true], treeStamp: originalTreeStamp });
    const historyLookup = vi.fn(async (_root: string, _from: string, _to: string, path: string) => path === 'a.ts');
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: () =>
        new Map([
          ['a.ts', resolved('f'.repeat(40))],
          ['nested/b.ts', resolved('e'.repeat(40))],
        ]),
      historyLookup,
      emit: settlementEmitMock(),
    });

    expect(result).toMatchObject({ inspected: 1, upgraded: ['WI-42476'], residual: 0, unreadable: [] });
    expect(historyLookup).toHaveBeenCalledTimes(1);
    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      historyAttestation?: {
        version: number;
        generation: number;
        evidenceHash: string;
        repositoryRoot: string;
        closeHeadSha: string;
        emittedCommitSha: string;
        paths: Array<{
          path: string;
          workingTreeBlobSha: string;
          fromHeadSha: string;
          toCommitSha: string;
          proof: string;
        }>;
      } | null;
      treeStamp?: unknown;
    };
    expect(evidence.historyAttestation).toEqual({
      version: 1,
      generation: manifest.generation,
      evidenceHash: manifest.evidenceHash,
      repositoryRoot: manifest.repositoryRoot,
      closeHeadSha: manifest.headSha,
      emittedCommitSha: SHA,
      // EI-24710716781971154: a MIXED row. a.ts was superseded (history proof); nested/b.ts is
      // still exact in the emitted tree. The close-time treeStamp cannot be refreshed (a.ts's
      // blob is not in this tree), and the migration-1207 floor demands a proof for EVERY
      // identity entry whose working blob differs from head — so nested/b.ts must be attested
      // too. Attesting only a.ts (the previous expectation) left the floor rejecting the row
      // and the trigger reverting the upgrade on every pass.
      paths: [
        {
          path: 'a.ts',
          workingTreeBlobSha: 'd'.repeat(40),
          fromHeadSha: manifest.headSha,
          toCommitSha: SHA,
          proof: 'exact-path-blob-history',
        },
        {
          path: 'nested/b.ts',
          workingTreeBlobSha: 'e'.repeat(40),
          fromHeadSha: manifest.headSha,
          toCommitSha: SHA,
          proof: 'exact-path-blob-history',
        },
      ],
    });
    expect(evidence.treeStamp).toEqual(originalTreeStamp);
  });

  it('attests exactly the identity entries the floor would call unproven — never one it does not read', async () => {
    // Floor inputs (migration 1207): treeStamp.contentIdentity entries. Three shapes beside the
    // superseded a.ts: already exact at close (head === working: needs nothing), an intentional
    // deletion (skipped by the floor), and an out-of-repo artifact (skipped by the floor).
    const exactAtClose = 'c.ts';
    const deleted = 'gone.ts';
    const external = 'elsewhere/x.bin';
    const richManifest = {
      ...manifest,
      normalizedPaths: ['a.ts', 'nested/b.ts', exactAtClose, deleted, external],
      contentIdentity: [
        ...manifest.contentIdentity,
        { path: exactAtClose, workingTreeBlobSha: '1'.repeat(40), headBlobSha: '1'.repeat(40) },
        { path: deleted, workingTreeBlobSha: null, headBlobSha: null, deletion: true },
        { path: external, workingTreeBlobSha: '2'.repeat(40), headBlobSha: null },
      ],
    };
    const treeStamp = {
      repositoryRoot: manifest.repositoryRoot,
      headSha: manifest.headSha,
      contentIdentity: [
        ...manifest.contentIdentity,
        { path: exactAtClose, workingTreeBlobSha: '1'.repeat(40), headBlobSha: '1'.repeat(40) },
        { path: deleted, workingTreeBlobSha: null, headBlobSha: null, deletion: true },
        { path: external, workingTreeBlobSha: '2'.repeat(40), headBlobSha: null, outOfRepoArtifact: true },
      ],
    };
    const sql = settlementSql({ updateHits: [true], manifest: richManifest, treeStamp });
    await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: () =>
        new Map([
          ['a.ts', resolved('f'.repeat(40))],
          ['nested/b.ts', resolved('e'.repeat(40))],
          [exactAtClose, resolved('1'.repeat(40))],
          [deleted, absent()],
          [external, resolved('2'.repeat(40))],
        ]),
      historyLookup: async (_root: string, _from: string, _to: string, path: string) => path === 'a.ts',
      emit: settlementEmitMock(),
    });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const evidence = (updateCall?.[1] as unknown as Record<string, unknown>)[
      TERMINAL_COMPLETION_EVIDENCE_KEY
    ] as { historyAttestation: { paths: Array<{ path: string }> } };
    // a.ts (history) + nested/b.ts (exact in tree, unproven at close). NOT c.ts (already exact
    // at close), NOT the deletion, NOT the out-of-repo artifact.
    expect(evidence.historyAttestation.paths.map((p) => p.path)).toEqual(['a.ts', 'nested/b.ts']);
  });

  it('does not count a row the authority floor kept proposed as settled, and emits no settled event', async () => {
    const emit = settlementEmitMock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
        sql: settlementSql({ updateHits: [true], floorRejects: true }),
        lookup: matchingLookup,
        emit,
      });
      // Zero residual and the UPDATE matched — yet RETURNING shows authority 'proposed', because
      // the floor trigger reverted it. Before EI-24710716781971154 this was reported as an upgrade.
      expect(result).toMatchObject({ inspected: 1, upgraded: [], residual: 0, floorRejected: ['WI-42476'] });
      expect(emit).not.toHaveBeenCalled();
      expect(warn.mock.calls.flat().join('\n')).toContain('kept proposed by the completion authority floor');
    } finally {
      warn.mockRestore();
    }
  });

  it('selects never-attempted rows before attempted ones, NULL-safely', async () => {
    const sql = settlementSql({ updateHits: [false] });
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit: settlementEmitMock() });
    const select = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('SELECT feature_id, harness_slug, payload'));
    const query = (select?.[0] as unknown as TemplateStringsArray).join('?');
    // Tier first, oldest-touched second. IS NOT DISTINCT FROM is load-bearing: `= 'array'` is NULL
    // for a row with no residualPaths key (the fresh-close case), and NULLs sort LAST ascending —
    // which would put every never-attempted row BEHIND the whole rotation, the original defect.
    expect(query).toMatch(
      /ORDER BY \(jsonb_typeof\(payload #> \?::text\[\]\) IS NOT DISTINCT FROM 'array'\) ASC,\s+updated_ts ASC, feature_id ASC/,
    );
    expect(select?.slice(1)).toContainEqual([TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'residualPaths']);
  });

  it('does not persist a complete history attestation while another declared path remains residual', async () => {
    const sql = settlementSql({ updateHits: [true] });
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: () =>
        new Map([
          ['a.ts', resolved('f'.repeat(40))],
          ['nested/b.ts', absent()],
        ]),
      historyLookup: async () => true,
      emit: settlementEmitMock(),
    });

    expect(result).toMatchObject({ inspected: 1, upgraded: [], residual: 1, unreadable: [] });
    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown>;
    expect(evidence.historyAttestation).toBeNull();
  });

  it('does NOT write a treeStamp for a partial/residual reconciliation (nothing to prove yet)', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true] });

    await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: () => new Map([['a.ts', resolved('f'.repeat(40))]]),
      emit,
    });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown>;
    expect(evidence.treeStamp).toBeUndefined();
  });
});

describe('reconcileProposedCompletionsAtCommit — P-004 settled event', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () => new Map([
    ['a.ts', resolved('d'.repeat(40))],
    ['nested/b.ts', resolved('e'.repeat(40))],
  ]);

  it('emits the latched settlement receipt once, only after a successful proposed→committed CAS', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true, false] });

    const first = await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });
    const replay = await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });

    expect(first.upgraded).toEqual(['WI-42476']);
    expect(replay.upgraded).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      key: 'work-item:settled:WI-42476',
      summary: `WI-42476 settlement committed at ${SHA.slice(0, 12)}`,
      payload: {
        id: 'WI-42476',
        harness: 'papercusp',
        commitSha: SHA,
        generation: 2,
        evidenceHash: 'b'.repeat(64),
      },
      source: 'git-sync-completion-settlement',
      workspaceId: 'papercusp-workspace',
    });
  });

  it('does not emit for residue or a missed CAS', async () => {
    const emit = settlementEmitMock();
    const residue = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [true] }),
      lookup: () => new Map([['a.ts', resolved('f'.repeat(40))]]),
      emit,
    });
    const missed = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [false] }),
      lookup: matchingLookup,
      emit,
    });

    expect(residue).toMatchObject({ upgraded: [], residual: 2 });
    expect(missed.upgraded).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps stale or out-of-order generations silent behind the evidence-scoped CAS', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [false] });

    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: matchingLookup,
      emit,
    });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    expect((updateCall?.[0] as unknown as TemplateStringsArray).join('?')).toContain("authority = 'proposed'");
    expect(updateCall?.slice(1)).toEqual(expect.arrayContaining([
      String(manifest.generation),
      manifest.evidenceHash,
    ]));
    expect(result).toMatchObject({ inspected: 1, upgraded: [] });
    expect(emit).not.toHaveBeenCalled();
  });

  it('selects by emitted checkout root and settles a row owned by another harness', async () => {
    const portalRoot = '/workspace/apps/portal';
    const crossHarnessManifest = { ...manifest, repositoryRoot: portalRoot };
    const payload = {
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: crossHarnessManifest },
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        expect(query).not.toContain('AND harness_slug =');
        expect(values).toContain(portalRoot);
        return [{ feature_id: 'WI-CROSS-HIVE', harness_slug: 'papercusp', payload }];
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        expect(values).toContain('papercusp');
        expect(values).toContain(portalRoot);
        return [{ feature_id: 'WI-CROSS-HIVE', authority: 'committed' }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    const emit = settlementEmitMock();

    const result = await reconcileProposedCompletionsAtCommit(SHA, {
      installSlug: 'portal',
      workspaceId: 'papercusp-workspace',
      repositoryRoot: portalRoot,
    }, { sql, lookup: matchingLookup, emit });

    expect(result).toMatchObject({ inspected: 1, upgraded: ['WI-CROSS-HIVE'], residual: 0 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'work-item:settled:WI-CROSS-HIVE',
      payload: expect.objectContaining({ harness: 'papercusp', commitSha: SHA }),
    }));
  });
});

describe('reconcileProposedCompletionsAtCommit — P-008 causal git fixture', () => {
  it('holds dependencies on a partial commit, then upgrades and emits exactly once on the complete commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-settlement-'));
    TEMP_ROOTS.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    const aBlob = git('hash-object', 'a.ts');
    const bBlob = git('hash-object', 'b.ts');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'partial');
    const partialSha = git('rev-parse', 'HEAD');

    const fixtureManifest = {
      ...manifest,
      repositoryRoot: root,
      normalizedPaths: ['a.ts', 'b.ts'],
      contentIdentity: [
        { path: 'a.ts', workingTreeBlobSha: aBlob, headBlobSha: null },
        { path: 'b.ts', workingTreeBlobSha: bBlob, headBlobSha: null },
      ],
    };
    let authority: 'proposed' | 'committed' = 'proposed';
    let payload: Record<string, unknown> = {
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: fixtureManifest },
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        return authority === 'proposed'
          ? [{ feature_id: 'WI-FIXTURE', harness_slug: 'papercusp', payload }]
          : [];
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        const evidence = payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
          settlementManifest: typeof fixtureManifest;
        };
        if (
          authority !== 'proposed'
          || values[7] !== String(evidence.settlementManifest.generation)
          || values[9] !== evidence.settlementManifest.evidenceHash
        ) return [];
        payload = values[0] as Record<string, unknown>;
        if (values[1] === 0) authority = 'committed';
        return [{ feature_id: 'WI-FIXTURE', authority: values[1] === 0 ? 'committed' : 'proposed' }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    const emit = settlementEmitMock();
    const scope = {
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      repositoryRoot: root,
    };

    const partial = await reconcileProposedCompletionsAtCommit(partialSha, scope, { sql, emit });
    expect(partial).toMatchObject({ upgraded: [], residual: 1 });
    expect((payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      settlementManifest: { residualPaths: unknown };
    }).settlementManifest.residualPaths).toEqual([{ path: 'b.ts', reason: 'missing-from-commit' }]);
    expect(isCompletionSettled(authority, true)).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    git('add', 'b.ts');
    git('commit', '-q', '-m', 'complete');
    const completeSha = git('rev-parse', 'HEAD');
    const complete = await reconcileProposedCompletionsAtCommit(completeSha, scope, { sql, emit });
    const replay = await reconcileProposedCompletionsAtCommit(completeSha, scope, { sql, emit });

    expect(complete).toMatchObject({ upgraded: ['WI-FIXTURE'], residual: 0 });
    expect(replay).toMatchObject({ inspected: 0, upgraded: [], residual: 0 });
    expect(isCompletionSettled(authority, true)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'work-item:settled:WI-FIXTURE',
      payload: expect.objectContaining({ commitSha: completeSha, generation: manifest.generation }),
    }));
  });
});

describe('WI-10005285 — one exact-tree read per settlement pass', () => {
  function gitFixture() {
    const root = mkdtempSync(join(tmpdir(), 'completion-settlement-batch-'));
    TEMP_ROOTS.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    mkdirSync(join(root, 'dir'));
    const blobs: Record<string, string> = {};
    for (const path of ['a.ts', 'b.ts', 'c.ts', 'dir/e.ts']) {
      writeFileSync(join(root, path), `export const v = ${JSON.stringify(path)};\n`);
      blobs[path] = git('hash-object', path);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
    return { root, blobs, sha: git('rev-parse', 'HEAD') };
  }

  function rowsSql(rows: Array<{ id: string; paths: string[]; blobs: Record<string, string>; root: string }>) {
    const updates: Array<{ id: string; residual: number }> = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        return rows.map(({ id, paths, blobs, root }) => ({
          feature_id: id,
          harness_slug: 'papercusp',
          payload: {
            [TERMINAL_COMPLETION_EVIDENCE_KEY]: {
              settlementManifest: {
                ...manifest,
                repositoryRoot: root,
                normalizedPaths: paths,
                contentIdentity: paths.map((path) => ({
                  path,
                  workingTreeBlobSha: blobs[path] ?? 'f'.repeat(40),
                  headBlobSha: null,
                })),
              },
            },
          },
        }));
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        // values: [payload, residualPaths.length, updated_ts, feature_id, ...]
        const id = String(values[3]);
        updates.push({ id, residual: Number(values[1]) });
        return [{ feature_id: id, authority: values[1] === 0 ? 'committed' : 'proposed' }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    return { sql, updates };
  }

  it('answers every row from one real git read, and isolates a row whose path git rejects', async () => {
    const { root, blobs, sha } = gitFixture();
    const calls: string[][] = [];
    const lookup: NonNullable<CompletionSettlementReconcilerDeps['lookup']> = async (repoRoot, headSha, paths, opts) => {
      calls.push([...paths]);
      return completionHeadBlobMap(repoRoot, headSha, paths, opts ?? {});
    };
    const { sql, updates } = rowsSql([
      { id: 'WI-AB', paths: ['a.ts', 'b.ts'], blobs, root },
      { id: 'WI-C', paths: ['c.ts'], blobs, root },
      // dir/e.ts settles; missing.ts is in no commit, so the row stays residual.
      { id: 'WI-RESIDUAL', paths: ['dir/e.ts', 'missing.ts'], blobs, root },
      // Measured live 2026-10-02: an out-of-repo path makes `git ls-tree` exit 128 for the
      // WHOLE call. It must cost only this row, never the batch.
      { id: 'WI-OUTSIDE', paths: ['a.ts', '/reports/rpt_fixture'], blobs, root },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reconcileProposedCompletionsAtCommit(
      sha,
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: root },
      { sql, lookup, emit: settlementEmitMock() },
    );
    warn.mockRestore();

    // One batched read over every safe declared path, plus ONE per-row read for the row that
    // declared a path the batch leaves out. Before WI-10005285 this pass made four reads.
    expect(calls).toEqual([
      ['a.ts', 'b.ts', 'c.ts', 'dir/e.ts', 'missing.ts'],
      ['a.ts', '/reports/rpt_fixture'],
    ]);
    expect(result.upgraded.sort()).toEqual(['WI-AB', 'WI-C']);
    expect(result.residual).toBe(1);
    expect(result.lookupUnavailable).toEqual(['WI-OUTSIDE']);
    expect(updates.find((u) => u.id === 'WI-RESIDUAL')).toEqual({ id: 'WI-RESIDUAL', residual: 1 });
  });

  it('gives each row exactly the verdict a per-row read gives it', async () => {
    const { root, blobs, sha } = gitFixture();
    const rows = [
      { id: 'WI-AB', paths: ['a.ts', 'b.ts'], blobs, root },
      { id: 'WI-DIR', paths: ['dir', 'dir/e.ts'], blobs, root },
      { id: 'WI-MISSING', paths: ['missing.ts', 'c.ts'], blobs, root },
    ];
    const run = async (rowSet: typeof rows) => {
      const { sql, updates } = rowsSql(rowSet);
      await reconcileProposedCompletionsAtCommit(
        sha,
        { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: root },
        { sql, lookup: (r, s, p, o) => completionHeadBlobMap(r, s, p, o ?? {}), emit: settlementEmitMock() },
      );
      return updates;
    };
    const batched = await run(rows);
    // A single-row pass never batches, so this is the per-row reference answer.
    const perRow = (await Promise.all(rows.map((row) => run([row])))).flat();
    const byId = (list: Array<{ id: string; residual: number }>) => [...list].sort((x, y) => x.id.localeCompare(y.id));
    expect(byId(batched)).toEqual(byId(perRow));
    expect(byId(batched).map((u) => u.residual)).toEqual([0, 1, 1]);
  });

  it('falls back to one read per row when the batched read measures nothing, and says so', async () => {
    const { sql, updates } = rowsSql([
      { id: 'WI-ONE', paths: ['a.ts'], blobs: { 'a.ts': 'd'.repeat(40) }, root: '/repo' },
      { id: 'WI-TWO', paths: ['nested/b.ts'], blobs: { 'nested/b.ts': 'e'.repeat(40) }, root: '/repo' },
    ]);
    const committed = new Map<string, HeadBlobResolution>([
      ['a.ts', resolved('d'.repeat(40))],
      ['nested/b.ts', resolved('e'.repeat(40))],
    ]);
    // The union read (two paths) measures nothing; each single-row read works.
    const lookup = vi.fn(
      async (_root: string, _sha: string, paths: readonly string[]): Promise<ReadonlyMap<string, HeadBlobResolution> | undefined> =>
        paths.length > 1 ? undefined : new Map(paths.map((p) => [p, committed.get(p)!] as const)),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reconcileProposedCompletionsAtCommit(
      SHA,
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: '/repo' },
      { sql, lookup, emit: settlementEmitMock() },
    );

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(result.upgraded.sort()).toEqual(['WI-ONE', 'WI-TWO']);
    expect(updates).toHaveLength(2);
    expect(warn.mock.calls.some(([line]) => String(line).includes('batched exact-tree read'))).toBe(true);
    warn.mockRestore();
  });

  it('reads the union once for concurrent callers and hands each caller only the paths it asked for', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = vi.fn(async (_r: string, _s: string, paths: readonly string[]) => {
      await gate;
      return new Map(paths.map((p) => [p, resolved(p.padEnd(40, '0'))] as [string, HeadBlobResolution]));
    });
    const onUnavailable = vi.fn();
    const lookup = batchHeadBlobLookup(base, '/repo', SHA, ['x', 'y', 'x'], undefined, onUnavailable);

    const pending = [lookup('/repo', SHA, ['x']), lookup('/repo', SHA, ['y']), lookup('/repo', SHA, ['x', 'y'])];
    release();
    const [x, y, both] = await Promise.all(pending);

    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0]![2]).toEqual(['x', 'y']);
    expect([...x!.keys()]).toEqual(['x']);
    expect([...y!.keys()]).toEqual(['y']);
    expect([...both!.keys()]).toEqual(['x', 'y']);
    expect(onUnavailable).not.toHaveBeenCalled();
    // A different commit is never served from this pass's tree.
    await lookup('/repo', 'b'.repeat(40), ['x']);
    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeStoredSettlementManifest — WI-1409142 stripped-null tolerance', () => {
  /**
   * The exact on-disk shape a recursive `jsonb_strip_nulls` produced: the null-valued
   * key is GONE, not null. `CompletionSettlementManifestSchema` requires it, so before
   * this fix every function below returned undefined and the reconciler skipped the
   * row in silence — permanently, since no later commit can restore a key.
   */
  const stripped = {
    ...manifest,
    contentIdentity: [
      { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40) },
      { path: 'nested/b.ts', workingTreeBlobSha: 'e'.repeat(40) },
    ],
  };

  it('settles a stripped manifest whose blobs are all present in the commit', async () => {
    expect(
      await residualPathsForCommit(
        stripped,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('e'.repeat(40))],
          ]),
      ),
    ).toEqual([]);
  });

  it('still reports honest residue for a stripped manifest that does not match', async () => {
    expect(
      await residualPathsForCommit(
        stripped,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('f'.repeat(40))],
          ]),
      ),
    ).toEqual([{ path: 'nested/b.ts', reason: 'content-mismatch' }]);
  });

  it('fills ONLY a missing key — an explicit null and a real sha both survive', () => {
    const out = normalizeStoredSettlementManifest({
      contentIdentity: [
        { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40) },
        { path: 'b.ts', workingTreeBlobSha: null, headBlobSha: 'e'.repeat(40) },
      ],
    }) as { contentIdentity: Record<string, unknown>[] };
    expect(out.contentIdentity[0]).toEqual({
      path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null,
    });
    expect(out.contentIdentity[1]).toEqual({
      path: 'b.ts', workingTreeBlobSha: null, headBlobSha: 'e'.repeat(40),
    });
  });

  it('leaves a value that is not a manifest untouched', () => {
    expect(normalizeStoredSettlementManifest(null)).toBeNull();
    expect(normalizeStoredSettlementManifest('nope')).toBe('nope');
    expect(normalizeStoredSettlementManifest({ contentIdentity: 'nope' }))
      .toEqual({ contentIdentity: 'nope' });
  });
});

/**
 * WI-10004711: a close whose declared file was edited again BEFORE git-sync captured the
 * close-time blob can never settle by waiting — the blob is in no commit and no longer in
 * the working tree. It used to read as plain `content-mismatch` forever, its closer told
 * "WAITING SETTLES THIS", with no signal ever sent (59 such rows in 7 days, measured
 * 2026-10-01; repro rows WI-10004498, WI-10004595).
 */
describe('WI-10004711 — superseded-before-commit verdict and the one-time closer notice', () => {
  const CLOSE_BLOB = 'd'.repeat(40);
  const LATER_BLOB = 'f'.repeat(40);
  // a.ts is committed at a DIFFERENT blob; nested/b.ts settles exactly.
  const emittedTree = () =>
    new Map([
      ['a.ts', resolved(LATER_BLOB)],
      ['nested/b.ts', resolved('e'.repeat(40))],
    ]);
  const neverCommitted = async () => false as const;
  const tree = (current: string | null | undefined) => (_root: string, path: string) =>
    path === 'a.ts' ? current : 'e'.repeat(40);
  const verdict = (history: CompletionSettlementReconcilerDeps['historyLookup'], current: string | null | undefined) =>
    residualPathsForCommit(manifest, SHA, emittedTree, undefined, history, undefined, tree(current));

  it('strands a path only when history was consulted AND the working tree moved off the close blob', async () => {
    expect(await verdict(neverCommitted, LATER_BLOB)).toEqual([{ path: 'a.ts', reason: 'superseded-before-commit' }]);
    // Deleted from the working tree after the close: no sweep can land the closed blob either.
    expect(await verdict(neverCommitted, null)).toEqual([{ path: 'a.ts', reason: 'superseded-before-commit' }]);
  });

  it('keeps plain content-mismatch whenever waiting could still settle it, or the facts are unmeasured', async () => {
    // The working tree STILL holds the close blob: the next sweep can land it.
    expect(await verdict(neverCommitted, CLOSE_BLOB)).toEqual([{ path: 'a.ts', reason: 'content-mismatch' }]);
    // The working tree could not be read: no verdict from a failed measurement.
    expect(await verdict(neverCommitted, undefined)).toEqual([{ path: 'a.ts', reason: 'content-mismatch' }]);
    // History was never consulted: an unconsulted `false` proves nothing.
    expect(await verdict(undefined, LATER_BLOB)).toEqual([{ path: 'a.ts', reason: 'content-mismatch' }]);
    // History could not answer: the server's failure, not the closer's.
    expect(await verdict(async () => undefined, LATER_BLOB)).toEqual([{ path: 'a.ts', reason: 'identity-unavailable' }]);
  });

  // EI-24821039535031884: a timed-out history read measured nothing, so the row is skipped
  // (undefined) and retried. CONTROLS in the same test: a deterministic refusal (undefined)
  // still persists `identity-unavailable`, and a measured `false` still persists a verdict,
  // so an implementation that returns undefined for every history answer cannot pass.
  it('skips the row on an unmeasured history read, but persists deterministic and measured answers', async () => {
    expect(await verdict(async () => 'unmeasured' as const, LATER_BLOB)).toBeUndefined();
    expect(await verdict(async () => undefined, LATER_BLOB)).toEqual([{ path: 'a.ts', reason: 'identity-unavailable' }]);
    expect(await verdict(neverCommitted, LATER_BLOB)).toEqual([{ path: 'a.ts', reason: 'superseded-before-commit' }]);
  });

  function strandedSql(storedManifest: unknown, updateHit = true) {
    const writes: Array<Record<string, Record<string, unknown>>> = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        return [{
          feature_id: 'WI-42476',
          harness_slug: 'papercusp',
          terminal_owner: 'su-closer',
          payload: { [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: storedManifest } },
        }];
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        writes.push(values[0] as Record<string, Record<string, unknown>>);
        return updateHit ? [{ feature_id: 'WI-42476', authority: 'proposed' }] : [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    return { sql, writes };
  }
  const scope = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: manifest.repositoryRoot };
  const strandedDeps = (sql: ReturnType<typeof strandedSql>['sql'], notifyStranded: CompletionSettlementReconcilerDeps['notifyStranded']) => ({
    sql,
    lookup: emittedTree,
    historyLookup: neverCommitted,
    workingTreeLookup: tree(LATER_BLOB),
    emit: settlementEmitMock(),
    notifyStranded,
  });

  it('notifies the recorded closer once, and the persisted residue re-reads cleanly so a replay stays silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(async () => {});
    const first = strandedSql(manifest);
    const pass1 = await reconcileProposedCompletionsAtCommit(SHA, scope, strandedDeps(first.sql, notify));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WI-42476'));

    expect(pass1).toMatchObject({ inspected: 1, upgraded: [], residual: 1, unreadable: [], stranded: ['WI-42476'] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      workItemId: 'WI-42476',
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
      terminalOwner: 'su-closer',
      strandedPaths: ['a.ts'],
      commitSha: SHA,
      generation: manifest.generation,
    });

    // The written manifest is what the NEXT pass reads. The new reason must survive the
    // schema, or every stranded row would turn into an `unreadable` one on that pass.
    const persisted = first.writes[0]![TERMINAL_COMPLETION_EVIDENCE_KEY]!.settlementManifest;
    expect((persisted as { residualPaths: unknown }).residualPaths)
      .toEqual([{ path: 'a.ts', reason: 'superseded-before-commit' }]);
    const replay = strandedSql(persisted);
    const pass2 = await reconcileProposedCompletionsAtCommit(SHA, scope, strandedDeps(replay.sql, notify));
    expect(pass2).toMatchObject({ inspected: 1, unreadable: [], stranded: [] });
    expect(notify).toHaveBeenCalledTimes(1);
    // The replay logs nothing new either: the stranded line fires on the transition only.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stays silent on a missed CAS, and a failing notice never fails the settlement pass', async () => {
    const notify = vi.fn(async () => {
      throw new Error('coord log unavailable');
    });
    const missed = await reconcileProposedCompletionsAtCommit(SHA, scope, strandedDeps(strandedSql(manifest, false).sql, notify));
    expect(missed.stranded).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = await reconcileProposedCompletionsAtCommit(SHA, scope, strandedDeps(strandedSql(manifest).sql, notify));
    expect(failed.stranded).toEqual(['WI-42476']);
    expect(notify).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a hermetic fixture (injected sql, no notice seam) never reaches the real coord log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      ...strandedDeps(strandedSql(manifest).sql, undefined),
    });
    // Still reported — only the side effect is withheld.
    expect(result.stranded).toEqual(['WI-42476']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('became unsettleable by waiting'));
    warn.mockRestore();
  });
});
