import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitSyncActionLivenessGuard } from './git-sync-action';
import {
  findZeroByteLooseObjects, runGitBounded, runGitSync, scanZeroByteLooseObjects, type RunGit,
} from './run-git-sync';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, readdir: vi.fn(real.readdir), lstat: vi.fn(real.lstat) };
});

const fakeRepo = '/fixture/repo';
const execGit = promisify(execFile);
const readDirectory: (path: string) => Promise<string[]> = readdir;
const nameFor = (index: number): string => index.toString(16).padStart(38, '0');
const gitDirRunner = (gitDir: string): RunGit => async () => ({ code: 0, stdout: gitDir, stderr: '' });

describe('loose object census on disk', () => {
  let repo: string;
  let objects: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'git-sync-object-census-'));
    objects = join(repo, '.git', 'objects');
    await mkdir(objects, { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(repo, { recursive: true, force: true });
  });

  it.each([3, 4, 5, 29])('checks the last of %i objects in the final fanout on each pass', async (count) => {
    await Promise.all(['ff', 'c0', 'b0', 'a0', '08', '07', '06', '05', '04'].map(async (fanout) => {
      await mkdir(join(objects, fanout));
      await writeFile(join(objects, fanout, nameFor(0)), 'valid size');
    }));
    for (let i = count - 1; i > 0; i--) await writeFile(join(objects, 'ff', nameFor(i)), 'valid size');
    const last = join(objects, 'ff', nameFor(count - 1));
    await writeFile(last, '');
    await symlink(last, join(objects, 'ff', nameFor(count)));
    await writeFile(join(objects, 'ff', 'tmp_obj_ignored'), '');
    const progress = vi.fn();
    const runGit = gitDirRunner(join(repo, '.git'));

    expect(await scanZeroByteLooseObjects(runGit, repo, { onProgress: progress })).toEqual([`ff${nameFor(count - 1)}`]);
    expect(progress).toHaveBeenLastCalledWith({ repoPath: repo, state: 'finished', directoriesRead: 10, objectsChecked: count + 9 });
    await rm(last);
    await writeFile(join(objects, '04', nameFor(0)), '');
    expect(await scanZeroByteLooseObjects(runGit, repo, {})).toEqual([`04${nameFor(0)}`]);
  });

  it.each([19, 20, 21, 37])('returns all %i corruption IDs while preserving the own-head repair limit', async (count) => {
    await mkdir(join(objects, 'aa'));
    const ids = Array.from({ length: count }, (_, i) => `aa${nameFor(i)}`);
    for (const id of [...ids].reverse()) await writeFile(join(objects, 'aa', id.slice(2)), '');
    const runGit = gitDirRunner(join(repo, '.git'));
    expect(await scanZeroByteLooseObjects(runGit, repo, {})).toEqual(ids);
    expect(await findZeroByteLooseObjects(runGit, repo)).toEqual(ids.slice(0, 20));
  });

  it('blocks isolated Git sync before fetch and reports corruption after the first 20 findings', async () => {
    const git = (...args: string[]) => execGit('git', args, { cwd: repo });
    await git('init', '-b', 'main');
    await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    const origin = join(repo, '.git', 'test-origin.git');
    await git('clone', '--bare', repo, origin);
    await git('remote', 'add', 'origin', origin);
    await mkdir(join(objects, 'ff'), { recursive: true });
    const ids = Array.from({ length: 21 }, (_, i) => `ff${nameFor(i)}`);
    for (const id of ids) await writeFile(join(objects, 'ff', id.slice(2)), '');
    const runGit = vi.fn<RunGit>((args, cwd) => runGitBounded(args, cwd, 15_000));
    const progress = vi.fn();
    const log = vi.fn();
    const options = { repoPath: repo, config: { pushSubmodules: false }, runGit, onLooseObjectScanProgress: progress, log };

    expect(await runGitSync('isolated-loose-object-test', options)).toMatchObject({
      status: 'error', errors: expect.arrayContaining([expect.objectContaining({
        message: expect.stringContaining(`21 zero-byte loose object(s): ${ids.join(', ')}`),
      })]),
    });
    expect(runGit.mock.calls.some(([args]) => args.includes('fetch'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('repair required before fetch'));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ repoPath: repo, state: 'finished' }));

    for (const id of ids) await rm(join(objects, 'ff', id.slice(2)));
    expect((await runGitSync('isolated-loose-object-test', options)).status).toBe('nothing');
    expect(runGit.mock.calls.some(([args]) => args.includes('fetch'))).toBe(true);
  });
});

describe('loose object census and action deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.mocked(readdir).mockReset();
    vi.mocked(lstat).mockReset();
    vi.useRealTimers();
  });

  function startScan({ reportProgress = true, statDelay = 350, hardTimeoutMs = 4_000 } = {}) {
    const guard = createGitSyncActionLivenessGuard({ idleTimeoutMs: 600, hardTimeoutMs, onTimeout: vi.fn() });
    const files = Array.from({ length: 28 }, (_, i) => nameFor(i));
    vi.mocked(readDirectory).mockImplementation(async path => (basename(path) === 'objects' ? ['aa'] : files));
    let pending = 0;
    let maxPending = 0;
    const healthy = { isFile: () => true, size: 1 } as Awaited<ReturnType<typeof lstat>>;
    vi.mocked(lstat).mockImplementation(() => new Promise(resolve => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      setTimeout(() => {
        pending -= 1;
        resolve(healthy);
      }, statDelay);
    }));
    const onProgress = vi.fn(({ state }: { state: string }) => {
      if (reportProgress && state === 'advanced') guard.touch();
    });
    let scan!: Promise<string[]>;
    const guarded = guard.run(() => {
      scan = scanZeroByteLooseObjects(gitDirRunner(join(fakeRepo, '.git')), fakeRepo, { signal: guard.signal, onProgress });
      return scan;
    }, 'run-git-sync');
    const verdict = guarded.then((ids) => ({ ids }), (error: unknown) => ({ error }));
    const scanExited = scan.then(() => null, (error: unknown) => error);
    return { guard, verdict, scanExited, onProgress, maxPending: () => maxPending };
  }

  it('the same advancing scan outlives the idle deadline only when completions are reported', async () => {
    const silent = startScan({ reportProgress: false });
    await vi.advanceTimersByTimeAsync(700);
    expect(await silent.verdict).toMatchObject({ error: { timeoutKind: 'idle', phase: 'run-git-sync' } });
    expect(await silent.scanExited).toBe(silent.guard.timeoutError);
    silent.guard.stop();

    const advancing = startScan();
    await vi.advanceTimersByTimeAsync(700);
    expect(advancing.guard.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1_800);
    expect(await advancing.verdict).toEqual({ ids: [] });
    expect(advancing.maxPending()).toBe(4);
    expect(advancing.onProgress).toHaveBeenLastCalledWith({
      repoPath: fakeRepo, state: 'finished', directoriesRead: 2, objectsChecked: 28,
    });
    advancing.guard.stop();
  });

  it('expires a stalled read and aborts without scheduling the next batch', async () => {
    const stalled = startScan({ statDelay: 2_000 });
    await vi.advanceTimersByTimeAsync(650);
    expect(await stalled.verdict).toMatchObject({ error: { timeoutKind: 'idle' } });
    expect(lstat).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_350);
    expect(await stalled.scanExited).toBe(stalled.guard.timeoutError);
    expect(lstat).toHaveBeenCalledTimes(4);
    expect(stalled.onProgress).toHaveBeenLastCalledWith({
      repoPath: fakeRepo, state: 'finished', directoriesRead: 2, objectsChecked: 0,
    });
    stalled.guard.stop();
  });

  it('still expires at the independent hard deadline while objects keep completing', async () => {
    const advancing = startScan({ hardTimeoutMs: 1_100 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await advancing.verdict).toMatchObject({ error: { timeoutKind: 'hard' } });
    expect(lstat).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(300);
    expect(await advancing.scanExited).toBe(advancing.guard.timeoutError);
    expect(lstat).toHaveBeenCalledTimes(16);
    advancing.guard.stop();
  });
});
