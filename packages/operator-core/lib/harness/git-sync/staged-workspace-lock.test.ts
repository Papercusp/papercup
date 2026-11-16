import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAttributedGroups, runGitSync, type RunGit } from './run-git-sync';
import { guardStagedWorkspaceLock, workspaceLockTreeValidator, workspaceLockTreeInspector } from './staged-workspace-lock';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const runGit: RunGit = async (args, cwd, options) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } });
  return { code: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};
const manifest = (version: string) => JSON.stringify({ name: 'fixture-app', dependencies: { next: version } });
const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: {
  '': {}, 'libs/app': { dependencies: { next: version } },
} });

describe('commit-boundary workspace dependency coherence (real git)', () => {
  let root: string;
  let repo: string;
  let child: string;
  let oldPin: string;
  const init = (path: string) => {
    git(root, 'init', '-b', 'main', path);
    git(path, 'config', 'user.name', 'Fixture');
    git(path, 'config', 'user.email', 'fixture@example.test');
    git(path, 'config', 'core.hooksPath', '/dev/null');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dependency-commit-'));
    const origin = join(root, 'child');
    init(origin);
    writeFileSync(join(origin, 'package.json'), manifest('1.0.0'));
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'child one');
    repo = join(root, 'repo');
    init(repo);
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'libs/app');
    child = join(repo, 'libs/app');
    git(child, 'config', 'user.name', 'Fixture');
    git(child, 'config', 'user.email', 'fixture@example.test');
    git(child, 'config', 'core.hooksPath', '/dev/null');
    oldPin = git(child, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: ['libs/*'] }));
    writeFileSync(join(repo, 'package-lock.json'), lock('1.0.0'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'coherent parent');
    writeFileSync(join(child, 'package.json'), manifest('2.0.0'));
    git(child, 'add', '-A');
    git(child, 'commit', '-m', 'child two');
    writeFileSync(join(repo, 'package-lock.json'), lock('2.0.0'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('agrees with the synchronous selected-object adapter on exact immutable diagnostics and identities', async () => {
    git(repo, 'add', 'package-lock.json');
    const tree = git(repo, 'write-tree');
    const sync = await import('../../../../../scripts/lint-as-committed.mjs');
    const result = await workspaceLockTreeInspector()(runGit, repo, tree);
    expect(result).toEqual(sync.inspectSelectedWorkspaceLock(repo, { oid: tree, kind: 'tree' }));
    expect(result).toMatchObject({ ok: false, treeOid: tree, mismatches: [{
      lockfile: 'package-lock.json', manifest: 'libs/app/package.json', controllingPaths: ['.gitmodules', 'libs/app'],
    }] });
  });

  it('keeps unreadable selected metadata distinct from classified mismatches', async () => {
    writeFileSync(join(repo, 'package-lock.json'), '{invalid');
    git(repo, 'add', 'package-lock.json');
    const tree = git(repo, 'write-tree');
    expect(await workspaceLockTreeInspector()(runGit, repo, tree)).toMatchObject({ ok: false,
      errors: [{ code: 'metadata-unreadable', path: 'package-lock.json' }] });
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({ ok: false, error: expect.stringContaining('unreadable dependency metadata') });
    expect(git(repo, 'write-tree')).toBe(tree);
  });

  it('reads shared immutable manifests once across distinct concurrent candidate trees without reusing a changed verdict', async () => {
    git(repo, 'add', 'package-lock.json');
    const firstTree = git(repo, 'write-tree');
    writeFileSync(join(repo, 'independent.txt'), 'unrelated source\n');
    git(repo, 'add', 'independent.txt');
    const secondTree = git(repo, 'write-tree');
    expect(secondTree).not.toBe(firstTree);

    const reads: Array<{ cwd: string; oid: string }> = [];
    const measuredGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'cat-file' && args[1] === 'blob') reads.push({ cwd, oid: args[2]! });
      return runGit(args, cwd, options);
    };
    const inspect = workspaceLockTreeInspector();
    const results = await Promise.all([firstTree, secondTree].map(tree => inspect(measuredGit, repo, tree)));
    const sync = await import('../../../../../scripts/lint-as-committed.mjs');
    for (const [index, tree] of [firstTree, secondTree].entries()) {
      expect(results[index]).toEqual(sync.inspectSelectedWorkspaceLock(repo, { oid: tree, kind: 'tree' }));
      expect(results[index].ok).toBe(false);
    }
    for (const path of ['package.json', 'package-lock.json', '.gitmodules']) {
      const oid = git(repo, 'rev-parse', `${firstTree}:${path}`);
      expect(reads.filter(read => read.cwd === repo && read.oid === oid), path).toHaveLength(1);
    }

    // An immutable text cache must not turn a new lock blob into an old verdict.
    writeFileSync(join(repo, 'package-lock.json'), lock('1.0.0'));
    git(repo, 'add', 'package-lock.json');
    const repairedTree = git(repo, 'write-tree');
    expect(await inspect(measuredGit, repo, repairedTree)).toEqual(
      sync.inspectSelectedWorkspaceLock(repo, { oid: repairedTree, kind: 'tree' }),
    );
    expect((await inspect(measuredGit, repo, repairedTree)).ok).toBe(true);
  });

  it('shares immutable reads across fresh validators for one reader while checking each candidate', async () => {
    git(repo, 'add', 'package-lock.json');
    const firstTree = git(repo, 'write-tree');
    writeFileSync(join(repo, 'independent.txt'), 'unrelated source\n');
    git(repo, 'add', 'independent.txt');
    const secondTree = git(repo, 'write-tree');
    const scans: Array<{ cwd: string; oid: string }> = [];
    const reads: Array<{ cwd: string; oid: string }> = [];
    const measuredGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'ls-tree' && args[1] === '-r') scans.push({ cwd, oid: args[3]! });
      if (args[0] === 'cat-file' && args[1] === 'blob') reads.push({ cwd, oid: args[2]! });
      return runGit(args, cwd, options);
    };
    await Promise.all([firstTree, secondTree].map(async tree => {
      await expect(workspaceLockTreeValidator()(measuredGit, repo, tree))
        .rejects.toThrow('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
    }));
    expect(scans.filter(scan => scan.cwd === child && scan.oid === oldPin)).toHaveLength(1);
    for (const path of ['package.json', 'package-lock.json', '.gitmodules']) {
      const oid = git(repo, 'rev-parse', `${firstTree}:${path}`);
      expect(reads.filter(read => read.cwd === repo && read.oid === oid), path).toHaveLength(1);
    }

    // Only immutable source reads are shared. A new lock must produce a new verdict.
    writeFileSync(join(repo, 'package-lock.json'), lock('1.0.0'));
    git(repo, 'add', 'package-lock.json');
    await expect(workspaceLockTreeValidator()(measuredGit, repo, git(repo, 'write-tree')))
      .resolves.toBeUndefined();
  });

  it('keeps fresh validator caches isolated by reader identity', async () => {
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    await workspaceLockTreeValidator()(runGit, repo, tree);
    const deniedGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'cat-file' && args[1] === 'blob') {
        return { code: 128, stdout: '', stderr: 'fixture reader cannot access selected blob' };
      }
      return runGit(args, cwd, options);
    };
    await expect(workspaceLockTreeValidator()(deniedGit, repo, tree))
      .rejects.toThrow('fixture reader cannot access selected blob');
  });

  it('retries an immutable blob read after failure instead of caching an unknown source', async () => {
    git(repo, 'add', 'package-lock.json');
    const tree = git(repo, 'write-tree');
    const oid = git(repo, 'rev-parse', `${tree}:package.json`);
    let attempts = 0;
    const recoveringGit: RunGit = async (args, cwd, options) => {
      if (cwd === repo && args[0] === 'cat-file' && args[1] === 'blob' && args[2] === oid && ++attempts === 1) {
        return { code: 128, stdout: '', stderr: 'fixture object temporarily unavailable' };
      }
      return runGit(args, cwd, options);
    };
    const inspect = workspaceLockTreeInspector();
    await expect(inspect(recoveringGit, repo, tree)).rejects.toThrow('fixture object temporarily unavailable');
    const sync = await import('../../../../../scripts/lint-as-committed.mjs');
    expect(await inspect(recoveringGit, repo, tree)).toEqual(
      sync.inspectSelectedWorkspaceLock(repo, { oid: tree, kind: 'tree' }),
    );
    expect(attempts).toBe(2);
  });

  it('holds a stale pinned manifest despite a coherent live child, preserving unrelated source and the shared index', async () => {
    const index = join(root, 'private-index');
    git(repo, 'add', 'package-lock.json');
    const shared = git(repo, 'write-tree');
    const privateGit: RunGit = (args, cwd) => runGit(args, cwd, { env: { GIT_INDEX_FILE: index } });
    await privateGit(['read-tree', 'HEAD'], repo);
    writeFileSync(join(repo, 'independent.txt'), 'source\n');
    await privateGit(['add', 'package-lock.json', 'independent.txt'], repo);
    const result = await guardStagedWorkspaceLock(privateGit, repo);
    expect(result).toMatchObject({ ok: true, held: ['package-lock.json'], reason: expect.stringContaining('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT') });
    expect((await privateGit(['diff', '--cached', '--name-only'], repo)).stdout.trim()).toBe('independent.txt');
    expect(git(repo, 'write-tree')).toBe(shared);
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(oldPin);
    expect(git(child, 'show', 'HEAD:package.json')).toBe(manifest('2.0.0'));
  });

  it('accepts the matching gitlink and lock in the same candidate', async () => {
    git(repo, 'add', 'libs/app', 'package-lock.json');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toEqual({ ok: true, held: [] });
  });

  it('validates selected child locks when the parent has no root lock', async () => {
    writeFileSync(join(child, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
      packages: { '': { dependencies: { next: '1.0.0' } } } }));
    git(child, 'add', 'package-lock.json');
    git(child, 'commit', '-m', 'incoherent child lock');
    git(repo, 'rm', '-f', 'package-lock.json');
    git(repo, 'add', 'libs/app');
    const tree = git(repo, 'write-tree');
    await expect(workspaceLockTreeValidator()(runGit, repo, tree))
      .rejects.toThrow('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
    expect(git(repo, 'write-tree')).toBe(tree);
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(oldPin);
  });

  it('refuses a missing pinned object without silently holding or rewriting the candidate', async () => {
    git(repo, 'update-index', '--cacheinfo', '160000', '1'.repeat(40), 'libs/app');
    git(repo, 'add', 'package-lock.json');
    const candidate = git(repo, 'write-tree');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({
      ok: false, error: expect.stringContaining('dependency tree read failed'),
    });
    expect(git(repo, 'write-tree')).toBe(candidate);
  });

  it('refuses unreadable metadata without treating it as a measured mismatch', async () => {
    writeFileSync(join(repo, 'package-lock.json'), '{invalid-json');
    git(repo, 'add', 'package-lock.json');
    const candidate = git(repo, 'write-tree');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({ ok: false });
    expect(git(repo, 'write-tree')).toBe(candidate);
  });

  it('preserves the comparator scope when an unrelated fixture has invalid JSON', async () => {
    const fixture = join(repo, 'fixtures', 'invalid');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'package.json'), '{intentionally-invalid-fixture');
    writeFileSync(join(fixture, 'package-lock.json'), '{intentionally-invalid-fixture-lock');
    git(repo, 'add', 'fixtures', 'libs/app', 'package-lock.json');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toEqual({ ok: true, held: [] });
  });

  it('refuses deferral when the retained base itself has incoherent dependencies', async () => {
    // A previously bad parent cannot become a safe fallback merely by unstaging.
    git(repo, 'add', 'package-lock.json');
    git(repo, 'commit', '-m', 'incoherent historical parent');
    writeFileSync(join(repo, 'package-lock.json'), lock('3.0.0'));
    writeFileSync(join(repo, 'independent.txt'), 'source\n');
    git(repo, 'add', 'package-lock.json', 'independent.txt');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({
      ok: false, error: expect.stringContaining('dependency deferral did not restore a coherent tree'),
    });
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('independent.txt');
  });

  describe('strict coherence against a drifted parent (R1)', () => {
    // The parent publishes lock 2.0.0 while its pin still selects manifest 1.0.0.
    const commitDriftedParent = () => {
      git(repo, 'add', 'package-lock.json');
      git(repo, 'commit', '-m', 'incoherent historical parent');
    };

    it('refuses a source-only candidate that inherits the parent drift', async () => {
      commitDriftedParent();
      writeFileSync(join(repo, 'independent.txt'), 'source\n');
      git(repo, 'add', 'independent.txt');
      const tree = git(repo, 'write-tree');
      await expect(workspaceLockTreeValidator()(runGit, repo, tree)).rejects.toThrow('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
      expect(git(repo, 'write-tree')).toBe(tree);
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('independent.txt');
    });

    it('lets a coherent curing gitlink through without deferring unrelated source', async () => {
      commitDriftedParent();
      writeFileSync(join(repo, 'independent.txt'), 'source\n');
      git(repo, 'add', 'libs/app', 'independent.txt');
      expect(await guardStagedWorkspaceLock(runGit, repo)).toEqual({ ok: true, held: [] });
      expect(git(repo, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual(['independent.txt', 'libs/app']);
    });

    it('refuses deferral when restoring dependency paths leaves the inherited base incoherent', async () => {
      commitDriftedParent();
      writeFileSync(join(repo, 'package-lock.json'), lock('3.0.0'));
      writeFileSync(join(repo, 'independent.txt'), 'source\n');
      git(repo, 'add', 'package-lock.json', 'independent.txt');
      await expect(workspaceLockTreeValidator()(runGit, repo, git(repo, 'write-tree'))).rejects.toThrow('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
      expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({ ok: false,
        error: expect.stringContaining('dependency deferral did not restore a coherent tree') });
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('independent.txt');
    });

    it('accepts a lock-only repair at the original pin despite newer child checkout bytes', async () => {
      commitDriftedParent();
      writeFileSync(join(repo, 'package-lock.json'), lock('1.0.0'));
      writeFileSync(join(repo, 'independent.txt'), 'source\n');
      git(repo, 'add', 'package-lock.json', 'independent.txt');
      await expect(workspaceLockTreeValidator()(runGit, repo, git(repo, 'write-tree'))).resolves.toBeUndefined();
      expect(await guardStagedWorkspaceLock(runGit, repo)).toEqual({ ok: true, held: [] });
      expect(git(repo, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual(['independent.txt', 'package-lock.json']);
    });
  });

  it('reads nested manifests from recursive committed pins instead of newer nested checkouts', async () => {
    const nestedOrigin = join(root, 'nested');
    init(nestedOrigin);
    writeFileSync(join(nestedOrigin, 'package.json'), JSON.stringify({ name: 'nested', dependencies: { next: '1.0.0' } }));
    git(nestedOrigin, 'add', '-A');
    git(nestedOrigin, 'commit', '-m', 'nested one');
    git(child, '-c', 'protocol.file.allow=always', 'submodule', 'add', nestedOrigin, 'nested');
    git(child, 'commit', '-am', 'pin nested one');
    const manifestRoot = { private: true, workspaces: ['libs/app', 'libs/app/nested'] };
    writeFileSync(join(repo, 'package.json'), JSON.stringify(manifestRoot));
    const nestedLock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: {
      '': {}, 'libs/app': { dependencies: { next: '2.0.0' } }, 'libs/app/nested': { dependencies: { next: version } },
    } });
    writeFileSync(join(repo, 'package-lock.json'), nestedLock('1.0.0'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'coherent recursive pins');
    const nested = join(child, 'nested');
    git(nested, 'config', 'user.name', 'Fixture');
    git(nested, 'config', 'user.email', 'fixture@example.test');
    git(nested, 'config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'nested', dependencies: { next: '2.0.0' } }));
    git(nested, 'commit', '-am', 'nested two');
    writeFileSync(join(repo, 'package-lock.json'), nestedLock('2.0.0'));
    git(repo, 'add', 'package-lock.json');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({ ok: true, held: ['package-lock.json'] });
  });

  it('holds an incompatible priority gitlink without its lock', async () => {
    git(repo, 'add', 'libs/app');
    expect(await guardStagedWorkspaceLock(runGit, repo)).toMatchObject({ ok: true, held: ['libs/app'] });
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('commits separately attributed lock and priority gitlink atomically without an incoherent intermediate commit', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const validate = workspaceLockTreeValidator();
    const result = await commitAttributedGroups(runGit, repo, new Map([
      ['package-lock.json', { agent: 'lock-author' }],
      ['libs/app', { agent: 'child-author' }],
    ]), [], 'dependency fixture', {
      priorityPaths: ['libs/app'],
      beforeCommit: async privateGit => {
        const guarded = await guardStagedWorkspaceLock(privateGit, repo, validate);
        return guarded.ok ? { ok: true } : guarded;
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.committedCount).toBe(1);
    const commits = git(repo, 'rev-list', `${base}..HEAD`).split('\n');
    for (const commit of commits) await expect(validate(runGit, repo, commit)).resolves.toBeUndefined();
    expect(git(repo, 'show', 'HEAD:package-lock.json')).toBe(lock('2.0.0'));
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(git(child, 'rev-parse', 'HEAD'));
    expect(git(repo, 'log', '-1', '--format=%B')).toContain('lock-author');
    expect(git(repo, 'log', '-1', '--format=%B')).toContain('child-author');
  });

  it('does not publish a lock for an excluded child and still commits independent source', async () => {
    writeFileSync(join(repo, 'independent.txt'), 'source\n');
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await commitAttributedGroups(runGit, repo, new Map([
      ['package-lock.json', { agent: 'lock-author' }],
      ['independent.txt', { agent: 'source-author' }],
    ]), ['libs/app'], 'dependency fixture', {
      priorityPaths: ['libs/app'],
      beforeCommit: async privateGit => {
        const guarded = await guardStagedWorkspaceLock(privateGit, repo);
        return guarded.ok ? { ok: true } : guarded;
      },
    });
    expect(result.committedAny).toBe(true);
    expect(git(repo, 'diff', '--name-only', base, 'HEAD')).toBe('independent.txt');
    expect(git(repo, 'show', 'HEAD:package-lock.json')).toBe(lock('1.0.0'));
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(oldPin);
  });

  it('enforces coherence through the full catch-all writer and reports a withheld dependency', async () => {
    const origin = join(root, 'parent.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
    writeFileSync(join(repo, 'independent.txt'), 'source\n');
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runGitSync('dependency-fixture', {
      repoPath: repo,
      runGit,
      config: { pushSubmodules: false, push: false },
      excludePaths: ['libs/app'],
      log: () => {},
    });
    expect(result.contentErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'package-lock.json', detectorKey: 'workspace-lock-coherence' }),
    ]));
    expect(git(repo, 'diff', '--name-only', base, 'HEAD')).toBe('independent.txt');
    expect(git(repo, 'show', 'HEAD:package-lock.json')).toBe(lock('1.0.0'));
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(oldPin);
  });

  it('propagates a newly held gitlink to its named importer while unrelated source commits', async () => {
    const origin = join(root, 'parent.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
    writeFileSync(join(child, 'new-provider.ts'), 'export const newValue = 2;\n');
    git(child, 'add', '-A');
    git(child, 'commit', '-m', 'new provider');
    // Only the gitlink is eligible. The old root lock cannot describe it yet.
    writeFileSync(join(repo, 'package-lock.json'), lock('1.0.0'));
    writeFileSync(join(repo, 'consumer.ts'), "import { newValue } from './libs/app/new-provider';\nexport const value = newValue;\n");
    writeFileSync(join(repo, 'independent.txt'), 'source\n');
    const base = git(repo, 'rev-parse', 'HEAD');
    await runGitSync('dependency-fixture', {
      repoPath: repo, runGit,
      config: { pushSubmodules: false, push: false },
      log: () => {},
    });
    expect(git(repo, 'diff', '--name-only', base, 'HEAD')).toBe('independent.txt');
    expect(git(repo, 'status', '--porcelain', 'consumer.ts')).not.toBe('');
    expect(git(repo, 'rev-parse', 'HEAD:libs/app')).toBe(oldPin);
  });
});
