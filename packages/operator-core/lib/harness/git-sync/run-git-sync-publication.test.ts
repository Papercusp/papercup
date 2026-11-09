import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { bridgeContainedCommitIntoCurrentBranch, GitSyncYieldError, runGitSync, type GitSyncRootCommit, type GitSyncStepRunner, type RunGit, type RunGitSyncOpts } from './run-git-sync';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'git-sync-publication-'));
  roots.push(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return String(result.stdout).trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@papercusp.local');
  git('config', 'user.name', 'publication test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'baseline a\n');
  writeFileSync(join(repo, 'b.txt'), 'baseline b\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'publication-fixture', dependencies: { next: '1.0.0' } }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { '': { dependencies: { next: '1.0.0' } } } }));
  git('add', '-A');
  git('commit', '-m', 'baseline');
  const validatedTrees: string[] = [];
  const runGit: RunGit = async (args, cwd, options) => {
    if (cwd === repo && args[0] === 'update-ref' && args.includes('HEAD')) {
      const commit = args[args.indexOf('HEAD') + 1]!;
      const tree = git('rev-parse', `${commit}^{tree}`);
      // Each real ordinary/attributed/anonymous publication must validate its
      // initial and final private tree, including after beforePublish callbacks.
      expect(validatedTrees.slice(-2)).toEqual([tree, tree]);
    }
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...options?.env },
    });
    if (cwd === repo && args[0] === 'cat-file' && args[1] === '-t' && result.stdout.trim() === 'tree') validatedTrees.push(args[2]!);
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const opts: RunGitSyncOpts = {
    repoPath: repo, runGit, submodulePaths: [],
    config: { push: false, pushSubmoduleOrigins: false },
    contentDetectors: [], deletionGuard: false, diffSubjects: false, log: () => {},
  };
  return { repo, git, runGit, opts };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('metadata publication population', () => {
  it('requires a disposition for every private publisher caller and parent ref writer', () => {
    const path = new URL('./run-git-sync.ts', import.meta.url);
    const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const owners = (node: ts.Node): string => {
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
        if (ts.isVariableDeclaration(p) && p.initializer &&
          (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText(source);
      }
      return '<root>';
    };
    const callers: string[] = [];
    const remoteCallers: string[] = [];
    const writers: string[] = [];
    const verbs = new Set(['update-ref', 'switch', 'checkout', 'reset', 'rebase', 'merge', 'commit', 'commit-tree', 'symbolic-ref', 'branch', 'push']);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'publishPrivateIndexCommit')
        callers.push(owners(node));
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'pushSelectedHead')
        remoteCallers.push(owners(node));
      // Command-name registries classify argv; they do not execute a writer.
      const commandRegistry = node.parent !== undefined && ts.isNewExpression(node.parent) && ts.isIdentifier(node.parent.expression) &&
        node.parent.expression.text === 'Set';
      // A closed Zod enum may contain a Git verb (e.g. origin authority
      // ['branch', 'default-head']); it declares data rather than dispatching Git.
      const schemaRegistry = node.parent !== undefined && ts.isCallExpression(node.parent) &&
        ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'enum' &&
        ts.isIdentifier(node.parent.expression.expression) && node.parent.expression.expression.text === 'z';
      if (ts.isArrayLiteralExpression(node) && !commandRegistry && !schemaRegistry) {
        const argv = node.elements.filter(ts.isStringLiteral).map(value => value.text);
        const verb = argv.find(value => verbs.has(value));
        // Path resets update an index only. symbolic-ref --quiet is a read.
        if (verb && !(verb === 'reset' && !argv.includes('--hard')) &&
          !(verb === 'symbolic-ref' && argv.includes('--quiet'))) writers.push(`${owners(node)}:${argv.join(' ')}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(callers.sort()).toEqual(['commitAttributedGroupsPass', 'commitOneRepoWithScratch', 'commitPriorityPaths', 'publishGitSyncCandidate']);
    expect(remoteCallers.sort()).toEqual(['firstPublishToEmptyRemote', 'reconcileAndPushOneRepo', 'reconcileAndPushOneRepo']);
    // This is a closed source census, not proof that ingress/recovery routes are
    // accepted. Those writers remain explicit in the plan's final population.
    expect(writers.sort()).toEqual([
      'ensureBranchAttachedForCommit:update-ref',
      'ensureBranchAttachedForCommit:switch', 'ensureBranchAttachedForCommit:switch',
      'ensureBranchAttachedForCommit:switch --create', 'ensureBranchAttachedForCommit:switch --create',
      'transplantInstallerSeedSnapshot:update-ref', 'transplantInstallerSeedSnapshot:reset --hard',
      'transplantInstallerSeedSnapshot:rebase --rebase-merges --onto', 'transplantInstallerSeedSnapshot:rebase --abort',
      'publishPrivateIndexCommit:commit-tree', 'publishPrivateIndexCommit:update-ref -m HEAD',
      'retain:update-ref', 'publishGitSyncCandidate:update-ref',
      'preserveVanishedStagedSourcesPass:update-ref',
      'bridgeContainedCommitIntoCurrentBranch:merge --no-edit -s ours', 'bridgeContainedCommitIntoCurrentBranch:merge --abort',
      'reconcileAndPushOneRepo:merge --no-edit', 'reconcileAndPushOneRepo:merge --abort', 'reconcileAndPushOneRepo:merge --abort',
      'pushSelectedHead:push',
    ].sort());
    const dispositions: Record<string, string> = {
      publishPrivateIndexCommit: 'P001 private publication: exact initial/final tree and CAS probes',
      retain: 'non-publication: captureGitSyncCandidate retains its existing source custody ref for v2/v3',
      publishGitSyncCandidate: 'non-publication: retained candidate commit ref; HEAD uses private publisher',
      preserveVanishedStagedSourcesPass: 'non-publication: vanished-source custody ref',
      ensureBranchAttachedForCommit: 'P003 branch attachment preserves the selected tree: existing/new/racing branch controls',
      transplantInstallerSeedSnapshot: 'P003 seed transplant binds approved source and retains recovery: adopt/replay/abort/qualification controls',
      bridgeContainedCommitIntoCurrentBranch: 'P003 contained ancestry bridge preserves the selected tree: entry parity and mismatch controls',
      reconcileAndPushOneRepo: 'P003 remote merge binds the selected tree and parents: initial/retry/conflict controls',
      pushSelectedHead: 'P003 immutable remote publication: first/ordinary refusal, retry revalidation and HEAD-race controls',
    };
    for (const writer of writers) expect(dispositions[writer.split(':')[0]!], writer).toBeTruthy();
  });
});

describe('immutable remote metadata publication', () => {
  function remoteFixture(seeded: boolean) {
    const f = fixture();
    const remote = mkdtempSync(join(tmpdir(), 'git-sync-publication-remote-'));
    roots.push(remote);
    f.git('init', '--bare', remote);
    f.git('remote', 'add', 'origin', remote);
    if (seeded) f.git('push', 'origin', 'HEAD:refs/heads/main');
    return { ...f, remote, opts: { ...f.opts, config: { ...f.opts.config, push: true, branch: 'main' } } };
  }

  function changeLock(f: ReturnType<typeof fixture>) {
    writeFileSync(join(f.repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
      packages: { '': { dependencies: { next: '2.0.0' } } } }));
    f.git('add', 'package-lock.json');
    f.git('commit', '-m', 'incoherent existing snapshot');
    return f.git('rev-parse', 'HEAD');
  }

  it.each(['existing', 'new', 'racing'] as const)('P003 branch attachment preserves the selected tree (%s)', async mode => {
    const f = remoteFixture(true);
    const base = f.git('rev-parse', 'HEAD');
    const baseTree = f.git('rev-parse', 'HEAD^{tree}');
    f.git('switch', '--detach', base);
    writeFileSync(join(f.repo, 'a.txt'), 'detached committed work\n');
    f.git('add', 'a.txt');
    f.git('commit', '-m', 'detached descendant');
    const detached = f.git('rev-parse', 'HEAD');
    const selectedTree = f.git('rev-parse', 'HEAD^{tree}');
    const peer = f.git('commit-tree', baseTree, '-p', base, '-m', 'concurrent branch owner');
    if (mode === 'new') f.git('branch', '-D', 'main');
    writeFileSync(join(f.repo, 'b.txt'), 'pending work triggers attachment\n');
    const attachments: string[][] = [];
    let raced = false;
    const runGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/heads/main') {
        expect(args.slice(1)).toEqual(['refs/heads/main', detached, base]);
        if (mode === 'racing') { f.git('update-ref', 'refs/heads/main', peer, base); raced = true; }
      }
      if (args[0] !== 'switch') return f.runGit(args, cwd, options);
      const before = f.git('rev-parse', 'HEAD^{tree}');
      const result = await f.runGit(args, cwd, options);
      attachments.push([before, f.git('rev-parse', 'HEAD^{tree}')]);
      return result;
    };
    const result = await runGitSync('test', { ...f.opts, runGit, config: { ...f.opts.config, push: false } });
    expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(base);
    if (mode === 'racing') {
      expect(raced).toBe(true);
      expect(result.status).toBe('error');
      expect(attachments).toEqual([]);
      expect(f.git('rev-parse', 'refs/heads/main')).toBe(peer);
      expect(f.git('rev-parse', 'HEAD')).toBe(detached);
      expect(f.git('branch', '--show-current')).toBe('');
      expect(readFileSync(join(f.repo, 'b.txt'), 'utf8')).toBe('pending work triggers attachment\n');
    } else {
      expect(result.status).toBe('synced');
      expect(attachments).toEqual([[selectedTree, selectedTree]]);
      expect(f.git('branch', '--show-current')).toBe('main');
      expect(f.git('show', 'HEAD:a.txt')).toBe('detached committed work');
      expect(f.git('show', 'HEAD:b.txt')).toBe('pending work triggers attachment');
    }
  });

  it.each(['adopt', 'replay', 'conflict', 'unretained', 'unapproved'] as const)(
    'P003 seed transplant binds approved source and retains recovery (%s)', async mode => {
      const f = remoteFixture(true);
      const base = f.git('rev-parse', 'HEAD');
      const baseTree = f.git('rev-parse', 'HEAD^{tree}');
      writeFileSync(join(f.repo, 'b.txt'), 'approved upstream bytes\n');
      f.git('add', 'b.txt');
      f.git('commit', '-m', 'upstream source');
      const upstream = f.git('rev-parse', 'HEAD');
      f.git('push', 'origin', `${upstream}:refs/heads/main`);
      const localPath = mode === 'conflict' ? 'b.txt' : 'a.txt';
      const replay = mode === 'replay' || mode === 'conflict';
      // Independent expected output is assembled before the synthetic history,
      // without calling the production transplant or its validation helpers.
      if (replay) {
        writeFileSync(join(f.repo, localPath), 'retained post-restore bytes\n');
        f.git('add', localPath);
      }
      const expectedTree = f.git('write-tree');
      f.git('reset', '--hard', upstream);
      const seed = f.git('commit-tree', baseTree, '-m', mode === 'unapproved' ? 'ordinary unrelated root' : 'papercusp seed snapshot HEAD');
      f.git('reset', '--hard', seed);
      if (mode !== 'unretained') f.git('update-ref', 'refs/remotes/origin/papercusp-seed-snapshot-fixture', seed);
      if (replay) {
        writeFileSync(join(f.repo, localPath), 'retained post-restore bytes\n');
        f.git('add', localPath);
        f.git('commit', '-m', 'post-restore work');
      }
      const original = f.git('rev-parse', 'HEAD');
      const originalTree = f.git('rev-parse', 'HEAD^{tree}');
      const result = await runGitSync('test', f.opts);
      const recovery = f.git('for-each-ref', '--format=%(refname)', 'refs/papercusp/seed-recovery/');
      if (mode === 'unretained' || mode === 'unapproved') {
        expect(result.status).toBe('error');
        expect(recovery).toBe('');
        expect(f.git('rev-parse', 'HEAD')).toBe(original);
        expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(upstream);
      } else {
        expect(recovery).toBe(`refs/papercusp/seed-recovery/${original}`);
        expect(f.git('rev-parse', recovery)).toBe(original);
        expect(f.git('rev-parse', `${recovery}^{tree}`)).toBe(originalTree);
        if (mode === 'conflict') {
          expect(result.status).toBe('error');
          expect(f.git('rev-parse', 'HEAD')).toBe(original);
          expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(originalTree);
          expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(upstream);
        } else {
          expect(result.status).toBe('synced');
          expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(expectedTree);
          f.git('merge-base', '--is-ancestor', upstream, 'HEAD');
          expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.git('rev-parse', 'HEAD'));
          if (mode === 'adopt') expect(f.git('rev-parse', 'HEAD')).toBe(upstream);
          else expect(f.git('show', '-s', '--format=%P', 'HEAD')).toBe(upstream);
        }
      }
      expect(f.git('status', '--porcelain')).toBe('');
    },
  );

  it.each(['represented', 'blob', 'mode', 'deletion'] as const)(
    'P003 contained ancestry bridge preserves the selected tree (%s)', async mode => {
      const f = fixture();
      const base = f.git('rev-parse', 'HEAD');
      writeFileSync(join(f.repo, 'a.txt'), 'source content\n');
      f.git('add', 'a.txt');
      f.git('commit', '-m', 'source lineage');
      const source = f.git('rev-parse', 'HEAD');
      f.git('branch', 'source', source);
      f.git('reset', '--hard', base);
      writeFileSync(join(f.repo, 'a.txt'), mode === 'blob' ? 'different local content\n' : 'source content\n');
      f.git('add', 'a.txt');
      if (mode === 'mode') f.git('update-index', '--chmod=+x', 'a.txt');
      if (mode === 'deletion') f.git('rm', '-f', 'a.txt');
      writeFileSync(join(f.repo, 'b.txt'), 'independent local work\n');
      f.git('add', 'b.txt');
      f.git('commit', '-m', 'independent local lineage');
      f.git('reset', '--hard', 'HEAD');
      const before = f.git('rev-parse', 'HEAD');
      const beforeTree = f.git('rev-parse', 'HEAD^{tree}');
      const result = await bridgeContainedCommitIntoCurrentBranch(f.runGit, f.repo, 'source', { log: () => {} });
      expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(beforeTree);
      if (mode === 'represented') {
        expect(result.status).toBe('bridged');
        expect(f.git('show', '-s', '--format=%P', 'HEAD').split(' ')).toEqual([before, source]);
        f.git('merge-base', '--is-ancestor', source, 'HEAD');
      } else {
        expect(result.status).toBe('declined');
        expect(f.git('rev-parse', 'HEAD')).toBe(before);
      }
      expect(f.git('status', '--porcelain')).toBe('');
      expect(f.git('rev-parse', 'source')).toBe(source);
    },
  );

  it.each([false, true])('P003 contained ancestry bridge checks exact gitlink parity (represented=%s)', async represented => {
    const f = fixture();
    const child = fixture();
    const childBase = child.git('rev-parse', 'HEAD');
    f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', child.repo, 'libs/child');
    f.git('commit', '-am', 'selected child baseline');
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(child.repo, 'a.txt'), 'advanced child object\n');
    child.git('commit', '-am', 'advanced child');
    const childNext = child.git('rev-parse', 'HEAD');
    f.git('-C', 'libs/child', 'fetch', 'origin', 'main');
    f.git('-C', 'libs/child', 'checkout', childNext);
    f.git('commit', '-am', 'source child pin');
    const source = f.git('rev-parse', 'HEAD');
    f.git('branch', 'source', source);
    f.git('reset', '--hard', base);
    f.git('-C', 'libs/child', 'checkout', represented ? childNext : childBase);
    writeFileSync(join(f.repo, 'b.txt'), 'independent parent work\n');
    f.git('add', '-A');
    f.git('commit', '-m', 'local child selection');
    const before = f.git('rev-parse', 'HEAD');
    const tree = f.git('rev-parse', 'HEAD^{tree}');
    const childHead = f.git('-C', 'libs/child', 'rev-parse', 'HEAD');
    const childRefs = f.git('-C', 'libs/child', 'show-ref');
    const result = await bridgeContainedCommitIntoCurrentBranch(f.runGit, f.repo, 'source', { log: () => {} });
    expect(result.status).toBe(represented ? 'bridged' : 'declined');
    expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(tree);
    if (represented) expect(f.git('show', '-s', '--format=%P', 'HEAD').split(' ')).toEqual([before, source]);
    else expect(f.git('rev-parse', 'HEAD')).toBe(before);
    expect(f.git('-C', 'libs/child', 'rev-parse', 'HEAD')).toBe(childHead);
    expect(f.git('-C', 'libs/child', 'show-ref')).toBe(childRefs);
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it.each([false, true])('P003 remote merge binds the selected tree and parents (conflict=%s)', async conflict => {
    const f = remoteFixture(true);
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.repo, conflict ? 'a.txt' : 'b.txt'), 'approved remote work\n');
    f.git('add', '-A');
    f.git('commit', '-m', 'remote lineage');
    const remote = f.git('rev-parse', 'HEAD');
    f.git('push', 'origin', `${remote}:refs/heads/main`);
    writeFileSync(join(f.repo, 'a.txt'), 'approved local work\n');
    f.git('add', 'a.txt');
    const expectedTree = f.git('write-tree');
    f.git('reset', '--hard', base);
    writeFileSync(join(f.repo, 'a.txt'), 'approved local work\n');
    f.git('add', 'a.txt');
    f.git('commit', '-m', 'local lineage');
    const local = f.git('rev-parse', 'HEAD');
    const localTree = f.git('rev-parse', 'HEAD^{tree}');
    const result = await runGitSync('test', f.opts);
    if (conflict) {
      expect(result.status).toBe('conflict');
      expect(f.git('rev-parse', 'HEAD')).toBe(local);
      expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(localTree);
      expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(remote);
    } else {
      expect(result.status).toBe('synced');
      expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(expectedTree);
      expect(f.git('show', '-s', '--format=%P', 'HEAD').split(' ')).toEqual([local, remote]);
      expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.git('rev-parse', 'HEAD'));
    }
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it.each([false, true])('refuses incoherent existing HEAD without moving the remote (seeded=%s)', async (seeded) => {
    const f = remoteFixture(seeded);
    const remoteBefore = seeded ? f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main') : null;
    const invalid = changeLock(f);
    const beforePush = vi.fn(async () => {});
    const result = await runGitSync('test', { ...f.opts, beforePush });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.errors.map(e => e.message).join('\n')).toContain('WORKSPACE_LOCK_DRIFT');
    expect(beforePush).not.toHaveBeenCalled();
    expect(f.git('rev-parse', 'HEAD')).toBe(invalid);
    expect(f.git('status', '--porcelain')).toBe('');
    if (seeded) expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
    else expect(f.git('--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');
  });

  it('transports only the validated OID when HEAD moves at the final authority boundary', async () => {
    const f = remoteFixture(false);
    const expected = f.git('rev-parse', 'HEAD');
    const expectedTree = f.git('rev-parse', 'HEAD^{tree}');
    const invalid = changeLock(f);
    f.git('reset', '--hard', expected);
    const beforePush = vi.fn(async (args: readonly string[], cwd: string) => {
      expect(cwd).toBe(f.repo);
      expect(args).toEqual(['push', 'origin', `${expected}:refs/heads/main`]);
      f.git('update-ref', 'HEAD', invalid, expected);
    });
    const result = await runGitSync('test', { ...f.opts, beforePush });
    expect(result.status).toBe('synced');
    expect(beforePush).toHaveBeenCalledOnce();
    expect(f.git('rev-parse', 'HEAD')).toBe(invalid);
    expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(expected);
    expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main^{tree}')).toBe(expectedTree);
  });

  it.each([false, true])('revalidates the exact retry merge before egress (incoherent peer=%s)', async (incoherent) => {
    const f = remoteFixture(true);
    const base = f.git('rev-parse', 'HEAD');
    let peer: string;
    if (incoherent) peer = changeLock(f);
    else {
      writeFileSync(join(f.repo, 'b.txt'), 'peer change\n');
      f.git('add', 'b.txt');
      f.git('commit', '-m', 'peer change');
      peer = f.git('rev-parse', 'HEAD');
    }
    f.git('reset', '--hard', base);
    writeFileSync(join(f.repo, 'a.txt'), 'local change\n');
    f.git('add', 'a.txt');
    f.git('commit', '-m', 'local change');
    const local = f.git('rev-parse', 'HEAD');
    const sent: string[] = [];
    const beforePush = async (args: readonly string[]) => {
      const refspec = args.at(-1)!;
      expect(refspec).toMatch(/^[a-f0-9]{40,64}:refs\/heads\/main$/);
      sent.push(refspec.split(':')[0]!);
      if (sent.length === 1) f.git('push', 'origin', `${peer}:refs/heads/main`);
    };
    const result = await runGitSync('test', { ...f.opts, beforePush });
    expect(sent[0]).toBe(local);
    const merged = f.git('rev-parse', 'HEAD');
    expect(merged).not.toBe(local);
    expect(f.git('show', '-s', '--format=%P', merged).split(' ')).toEqual([local, peer]);
    if (incoherent) {
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.errors.map(e => e.message).join('\n')).toContain('WORKSPACE_LOCK_DRIFT');
      expect(sent).toEqual([local]);
      expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(peer);
    } else {
      expect(result.status).toBe('synced');
      expect(sent).toEqual([local, merged]);
      expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main')).toBe(merged);
      expect(f.git('--git-dir', f.remote, 'rev-parse', 'refs/heads/main^{tree}')).toBe(f.git('rev-parse', `${merged}^{tree}`));
    }
  });
});

describe('EI-270796 root publication notifications', () => {
  it('notifies a published group while a later publication remains pending', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'agent a\n');
    writeFileSync(join(f.repo, 'b.txt'), 'agent b\n');
    const reachedLater = gate();
    const releaseLater = gate();
    const commits: GitSyncRootCommit[] = [];
    let publications = 0;
    const running = runGitSync('test', {
      ...f.opts,
      loadRoster: async () => [
        { agent: 'su-a', intent: 'a', files: ['a.txt'] },
        { agent: 'su-b', intent: 'b', files: ['b.txt'] },
      ],
      runGit: async (args, cwd, options) => {
        const publishing = args[0] === 'update-ref' && args.includes('HEAD');
        if (publishing && publications === 1) {
          reachedLater.resolve();
          await releaseLater.promise;
        }
        const result = await f.runGit(args, cwd, options);
        if (publishing && result.code === 0) publications++;
        return result;
      },
      onRootCommit: (commit) => commits.push(commit),
    });
    try {
      await reachedLater.promise;
      expect(publications).toBe(1);
      expect(commits).toEqual([{ sha: f.git('rev-parse', 'HEAD'), committedAtMs: expect.any(Number) }]);
    } finally {
      releaseLater.resolve();
      await running;
    }
    expect(commits).toHaveLength(publications);
    expect(commits.map((commit) => commit.sha)).toEqual(f.git('rev-list', '--reverse', 'HEAD~2..HEAD').split('\n'));
  });

  it('replays per-commit producer proof before the later push phase without retimestamping', async () => {
    const f = fixture();
    const outputs = new Map<string, unknown>();
    const step: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (outputs.has(name)) return structuredClone(outputs.get(name)) as T;
      const result = await operation();
      outputs.set(name, structuredClone(result));
      return result;
    };
    const first: GitSyncRootCommit[] = [];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    writeFileSync(join(f.repo, 'a.txt'), 'first tick\n');
    await runGitSync('test', { ...f.opts, step, onRootCommit: (commit) => first.push(commit) });
    expect(first).toHaveLength(1);
    expect(first[0]?.committedAtMs).toBe(1_000);
    now.mockReturnValue(4_000);
    writeFileSync(join(f.repo, 'later.txt'), 'later independent tick\n');
    f.git('add', '-A');
    f.git('commit', '-m', 'later tick');
    const replay: GitSyncRootCommit[] = [];
    const replayStep: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (name === 'git-sync:push') expect(replay).toEqual(first);
      return step(name, operation);
    };
    const result = await runGitSync('test', { ...f.opts, step: replayStep, onRootCommit: (commit) => replay.push(commit) });
    expect(replay).toEqual(first);
    expect(result.localCommits).toEqual(first);
    expect(replay[0]?.sha).not.toBe(f.git('rev-parse', 'HEAD'));

    // Legacy checkpoints retain their aggregate SHA, but cannot manufacture
    // individual producer times from the clock at which they are replayed.
    const legacy = { ...outputs.get('git-sync:pointer-bump') as Record<string, unknown> };
    delete legacy.localCommits;
    delete legacy.localCommitAtMs;
    outputs.set('git-sync:pointer-bump', legacy);
    const notify = vi.fn();
    const legacyResult = await runGitSync('test', { ...f.opts, step, onRootCommit: notify });
    expect(notify).not.toHaveBeenCalled();
    expect(legacyResult.localCommitSha).toBe(first[0]?.sha);
    expect(legacyResult.localCommitAtMs).toBeUndefined();
    expect(legacyResult.localCommits).toBeUndefined();
  });

  it('retains already delivered producer proof when a later group yields', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'agent a\n');
    writeFileSync(join(f.repo, 'b.txt'), 'agent b\n');
    const commits: GitSyncRootCommit[] = [];
    let failure: unknown;
    try {
      await runGitSync('test', {
        ...f.opts,
        loadRoster: async () => [
          { agent: 'su-a', intent: 'a', files: ['a.txt'] },
          { agent: 'su-b', intent: 'b', files: ['b.txt'] },
        ],
        onRootCommit: (commit) => commits.push(commit),
        shouldYield: async () => commits.length > 0 ? 'restart requested' : null,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitSyncYieldError);
    expect(commits).toHaveLength(1);
    expect((failure as GitSyncYieldError).localCommits).toEqual(commits);
    expect((failure as GitSyncYieldError).localCommitAtMs).toBe(commits[0]?.committedAtMs);
    expect(commits[0]?.sha).toBe(f.git('rev-parse', 'HEAD'));
    expect(f.git('status', '--porcelain')).toContain('b.txt');
  });

  it.each([false, true])('announces only the root gitlink publication, with root CAS refused=%s', async (refuseRoot) => {
    const f = fixture();
    const source = fixture();
    f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', source.repo, 'child');
    f.git('commit', '-am', 'add child');
    const baseline = f.git('rev-parse', 'HEAD');
    const child = join(f.repo, 'child');
    // Child commits contribute to aggregate counts but are not root publications.
    f.git('-C', child, 'config', 'user.email', 'test@papercusp.local');
    f.git('-C', child, 'config', 'user.name', 'publication test');
    writeFileSync(join(child, 'a.txt'), 'child edit\n');
    const commits: GitSyncRootCommit[] = [];
    const result = await runGitSync('test', {
      ...f.opts, submodulePaths: ['child'],
      onRootCommit: (commit) => commits.push(commit),
      runGit: async (args, cwd, options) => refuseRoot && cwd === f.repo && args[0] === 'update-ref' && args.includes('HEAD')
        ? { code: 1, stdout: '', stderr: 'injected root CAS refusal' }
        : f.runGit(args, cwd, options),
    });
    expect(f.git('-C', child, 'show', 'HEAD:a.txt')).toBe('child edit');
    expect(result.committedCount).toBeGreaterThan(0);
    expect(commits.map((commit) => commit.sha)).not.toContain(f.git('-C', child, 'rev-parse', 'HEAD'));
    if (refuseRoot) {
      expect(commits).toEqual([]);
      expect(result.localCommitSha).toBeUndefined();
      expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
    } else {
      expect(commits).toEqual([{ sha: f.git('rev-parse', 'HEAD'), committedAtMs: expect.any(Number) }]);
      expect(result.localCommits).toEqual(commits);
    }
  });

  it('does not announce commit objects whose publication CAS was refused', async () => {
    const f = fixture();
    const baseline = f.git('rev-parse', 'HEAD');
    const notify = vi.fn();
    writeFileSync(join(f.repo, 'a.txt'), 'unpublished\n');
    const result = await runGitSync('test', {
      ...f.opts, onRootCommit: notify,
      runGit: async (args, cwd, options) => args[0] === 'update-ref' && args.includes('HEAD')
        ? { code: 1, stdout: '', stderr: 'injected CAS refusal' }
        : f.runGit(args, cwd, options),
    });
    expect(result.status).toBe('error');
    expect(notify).not.toHaveBeenCalled();
    expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
  });

  it('refuses publication when the runner cannot isolate the private index', async () => {
    const f = fixture();
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.repo, 'a.txt'), 'shared-index publication\n');
    const commits: GitSyncRootCommit[] = [];
    const log = vi.fn();
    const result = await runGitSync('test', {
      ...f.opts, log,
      // Model a legacy runner that does not forward GIT_INDEX_FILE.
      runGit: (args, cwd) => f.runGit(args, cwd),
      onRootCommit: (commit) => commits.push(commit),
    });
    expect(result).toMatchObject({ status: 'error', errors: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('catch-all private index unavailable') }),
    ]) });
    expect(commits).toEqual([]);
    expect(f.git('rev-parse', 'HEAD')).toBe(base);
    expect(f.git('diff', '--name-only', 'HEAD')).toContain('a.txt');
  });

  it('keeps notification failure separate from successful publication', async () => {
    const f = fixture();
    const log = vi.fn();
    writeFileSync(join(f.repo, 'a.txt'), 'committed despite observer\n');
    const result = await runGitSync('test', {
      ...f.opts, log, onRootCommit: () => { throw new Error('observer unavailable'); },
    });
    expect(result.localCommitSha).toBe(f.git('rev-parse', 'HEAD'));
    expect(result.localCommits).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('root commit notification failed'));
  });
});
