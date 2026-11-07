/** Real-Git P002 capture contracts; registered by the maintained integration router. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGitSyncCandidate, SOURCE_CUSTODY_REF_PREFIX, type RunGit } from './run-git-sync';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(unborn = false) {
  const repo = mkdtempSync(join(tmpdir(), 'git-sync-candidate-'));
  roots.push(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return String(result.stdout).trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@papercusp.local');
  git('config', 'user.name', 'candidate test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'baseline a\n');
  writeFileSync(join(repo, 'b.txt'), 'baseline b\n');
  if (!unborn) {
    git('add', '-A');
    git('commit', '-m', 'baseline');
  }
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...options?.env },
    });
    if (result.status !== 0 && args[0] === 'add') {
      const flags = spawnSync('git', ['ls-files', '-v'], {
        cwd, encoding: 'utf8', env: { ...process.env, ...options?.env }, timeout: 30_000,
      });
      console.error('candidate fixture stage failed', { args, code: result.status,
        stderr: result.stderr, privateFlags: flags.stdout });
    }
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  return { repo, git, runGit };
}

/** Read raw bytes: status may itself rewrite the index stat cache. */
function candidateState(f: ReturnType<typeof fixture>) {
  let index: string | null = null;
  try { index = readFileSync(join(f.repo, '.git/index')).toString('base64'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = ['a.txt', 'b.txt', 'new.txt'].map(path => {
    try {
      const stat = lstatSync(join(f.repo, path));
      return { path, mode: stat.mode, value: stat.isSymbolicLink()
        ? readlinkSync(join(f.repo, path)) : readFileSync(join(f.repo, path)).toString('base64') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, absent: true };
    }
  });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.repo, encoding: 'utf8' });
  return { index, entries: f.git('ls-files', '--stage', '--debug'), files,
    head: head.status === 0 ? head.stdout.trim() : null };
}

function unmerge(f: ReturnType<typeof fixture>) {
  const one = f.git('rev-parse', 'HEAD:a.txt');
  const two = f.git('rev-parse', 'HEAD:b.txt');
  f.git('update-index', '--force-remove', '--', 'a.txt');
  const staged = spawnSync('git', ['update-index', '--index-info'], { cwd: f.repo,
    input: `100644 ${one} 1\ta.txt\n100644 ${two} 2\ta.txt\n100644 ${one} 3\ta.txt\n`, encoding: 'utf8' });
  expect(staged.status).toBe(0);
}

describe('lifecycle P002 immutable candidate custody', () => {
  it.each(['staged', 'unstaged', 'split', 'deletion', 'executable', 'symlink', 'intent-to-add'] as const)(
    'captures A1 and replays it without changing a later %s shared index or B1', async state => {
      const f = fixture();
      const a1 = state === 'symlink' ? Buffer.from('A1-link-target') : Buffer.from([65, 49, 0, 255, 10]);
      writeFileSync(join(f.repo, 'a.txt'), a1);
      if (state === 'staged') f.git('add', '--', 'a.txt');
      if (state === 'split') {
        writeFileSync(join(f.repo, 'a.txt'), 'A0 staged\n'); f.git('add', '--', 'a.txt');
        writeFileSync(join(f.repo, 'a.txt'), a1);
      }
      if (state === 'deletion') f.git('rm', '--', 'b.txt');
      if (state === 'executable') { chmodSync(join(f.repo, 'a.txt'), 0o755); f.git('add', '--', 'a.txt'); }
      if (state === 'symlink') {
        rmSync(join(f.repo, 'a.txt')); symlinkSync(a1.toString(), join(f.repo, 'a.txt'));
        f.git('add', '--', 'a.txt');
      }
      if (state === 'intent-to-add') { writeFileSync(join(f.repo, 'new.txt'), 'A1 new\n'); f.git('add', '-N', '--', 'new.txt'); }
      const request = { requestId: 'operation-1', generation: 1, base: f.git('rev-parse', 'HEAD'),
        paths: state === 'intent-to-add' ? ['a.txt', 'new.txt'] : state === 'deletion' ? ['a.txt', 'b.txt'] : ['a.txt'] };
      const before = candidateState(f);
      const first = await captureGitSyncCandidate(f.runGit, f.repo, request);
      if (!first.ok) throw new Error(first.error);
      expect(candidateState(f)).toEqual(before);
      const payload = spawnSync('git', ['show', `${first.candidate.tree}:a.txt`], { cwd: f.repo });
      expect(payload.status).toBe(0);
      expect(payload.stdout).toEqual(a1);
      expect(f.git('ls-tree', first.candidate.tree, '--', 'a.txt')).toMatch(
        new RegExp('^' + (state === 'symlink' ? '120000' : state === 'executable' ? '100755' : '100644') + ' blob '));
      if (state === 'deletion') expect(f.git('ls-tree', first.candidate.tree, '--', 'b.txt')).toBe('');
      if (state === 'intent-to-add') expect(f.git('show', `${first.candidate.tree}:new.txt`)).toBe('A1 new');
      rmSync(join(f.repo, 'a.txt'), { force: true });
      writeFileSync(join(f.repo, 'a.txt'), 'B1 later source\n');
      if (state === 'staged' || state === 'split') f.git('add', '--', 'a.txt');
      if (state === 'split') writeFileSync(join(f.repo, 'a.txt'), 'B2 unstaged source\n');
      if (state === 'deletion') f.git('rm', '-f', '--', 'a.txt');
      if (state === 'executable') { chmodSync(join(f.repo, 'a.txt'), 0o755); f.git('add', '--', 'a.txt'); }
      if (state === 'symlink') {
        rmSync(join(f.repo, 'a.txt')); symlinkSync('B1-link-target', join(f.repo, 'a.txt'));
        f.git('add', '--', 'a.txt');
      }
      if (state === 'intent-to-add') {
        writeFileSync(join(f.repo, 'new.txt'), 'B1 intent to add\n'); f.git('add', '-N', '--', 'new.txt');
      }
      const later = candidateState(f);
      expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(first);
      expect(candidateState(f)).toEqual(later);
      expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe(first.ref);
      expect(readdirSync(join(f.repo, '.git')).filter(path => path.startsWith('papercusp-git-sync-candidate-'))).toEqual([]);
    },
  );

  it('refuses a new unmerged candidate without changing index stages, working bytes or HEAD', async () => {
    const f = fixture();
    unmerge(f);
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: 'unmerged', generation: 1, base: before.head, paths: ['a.txt'],
    })).toEqual({ ok: false, error: 'source-custody-refused:candidate-unmerged-index' });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });

  it.each(['objects', 'ref'] as const)('recovers a stop after %s capture without recapturing B1', async point => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'restart', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const before = candidateState(f);
    let stopped = false;
    const stop: RunGit = async (args, cwd, options) => {
      const result = await f.runGit(args, cwd, options);
      if (!stopped && (point === 'objects' ? args[0] === 'write-tree' : args[0] === 'update-ref')) {
        stopped = true; throw new Error('injected stop');
      }
      return result;
    };
    expect((await captureGitSyncCandidate(stop, f.repo, request)).ok).toBe(false);
    expect(stopped).toBe(true);
    expect(candidateState(f)).toEqual(before);
    if (point === 'ref') writeFileSync(join(f.repo, 'a.txt'), 'B1\n');
    const later = candidateState(f);
    const recovered = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!recovered.ok) throw new Error(recovered.error);
    expect(f.git('show', `${recovered.candidate.tree}:a.txt`)).toBe('A1');
    expect(candidateState(f)).toEqual(later);
  });

  it('refuses changed inputs under the same generation and accepts a new generation', async () => {
    const f = fixture();
    const request = { requestId: 'immutable', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, paths: ['b.txt'] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-input-mismatch' });
    expect(candidateState(f)).toEqual(before);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, generation: 2, paths: ['b.txt'] })).toMatchObject({ ok: true });
  });

  it.each(['assume-unchanged', 'skip-worktree'] as const)('captures working bytes beneath %s without changing shared flags', async flag => {
    const f = fixture();
    f.git('update-index', '--' + flag, '--', 'a.txt');
    writeFileSync(join(f.repo, 'a.txt'), 'A1 flagged\n');
    const before = candidateState(f);
    const result = await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: flag, generation: 1, base: before.head, paths: ['a.txt'],
    });
    if (!result.ok) throw new Error(result.error);
    expect(f.git('show', `${result.candidate.tree}:a.txt`)).toBe('A1 flagged');
    expect(candidateState(f)).toEqual(before);
  });

  it('retains an empty candidate tree when all tracked files are deleted', async () => {
    const f = fixture();
    f.git('rm', '--', 'a.txt', 'b.txt');
    const before = candidateState(f);
    const request = { requestId: 'empty', generation: 1, base: before.head, paths: ['a.txt', 'b.txt'] };
    const result = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!result.ok) throw new Error(result.error);
    expect(f.git('ls-tree', result.candidate.tree)).toBe('');
    writeFileSync(join(f.repo, 'a.txt'), 'B1 new\n');
    const later = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(result);
    expect(candidateState(f)).toEqual(later);
  });

  it('captures an unborn repository without creating a shared index or branch commit', async () => {
    const f = fixture(true);
    writeFileSync(join(f.repo, 'a.txt'), 'A1 unborn\n');
    const before = candidateState(f);
    const result = await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: 'unborn', generation: 1, base: null, paths: ['a.txt'],
    });
    if (!result.ok) throw new Error(result.error);
    expect(f.git('show', `${result.candidate.tree}:a.txt`)).toBe('A1 unborn');
    expect(f.git('ls-tree', result.candidate.tree, '--', 'b.txt')).toBe('');
    expect(candidateState(f)).toEqual(before);
  });

  it('replays acknowledged A1 after the later shared index becomes unmerged', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'acknowledged', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const first = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!first.ok) throw new Error(first.error);
    unmerge(f);
    writeFileSync(join(f.repo, 'a.txt'), 'B1 conflict\n');
    const later = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(first);
    expect(candidateState(f)).toEqual(later);
  });

  it.each(['clean-filter', 'crlf', 'ident'] as const)('refuses %s conversion instead of acknowledging altered working bytes', async conversion => {
    const f = fixture();
    const raw = conversion === 'crlf' ? 'A1\r\n' : conversion === 'ident' ? '$Id: expanded-value $\n' : 'A1 lowercase\n';
    if (conversion === 'clean-filter') {
      writeFileSync(join(f.repo, '.gitattributes'), 'a.txt filter=fixture\n');
      f.git('config', 'filter.fixture.clean', 'tr a-z A-Z');
    } else if (conversion === 'crlf') {
      f.git('config', 'core.autocrlf', 'true');
    } else {
      writeFileSync(join(f.repo, '.gitattributes'), 'a.txt ident\n');
    }
    writeFileSync(join(f.repo, 'a.txt'), raw);
    // Calibrate against real Git: this fixture actually changes blob bytes.
    const normalized = f.git('hash-object', '-w', '--path=a.txt', '--', 'a.txt');
    const blob = spawnSync('git', ['cat-file', 'blob', normalized], { cwd: f.repo });
    expect(blob.status).toBe(0);
    expect(blob.stdout).not.toEqual(Buffer.from(raw));
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: conversion, generation: 1, base: before.head, paths: ['a.txt'],
    })).toEqual({ ok: false, error: 'source-custody-refused:candidate-working-transform-unsupported' });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });
});
