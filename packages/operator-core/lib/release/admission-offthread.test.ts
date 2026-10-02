/**
 * WI-10005223: admission git runs on a REAL worker thread (the tsx bootstrap, since this
 * source tree has no bundled .mjs beside the module), never on the caller's event loop.
 * Every case drives a real git repo; nothing here is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_WORKER_TSX_BOOTSTRAP,
  admissionOffthreadStats,
  admissionWorkerEntry,
  configureAdmissionOffthread,
  resetAdmissionOffthread,
  runAdmissionJob,
} from './admission-offthread';
import { executeAdmissionJob } from './admission-jobs';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'admission-offthread-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'staging');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  // Shell aliases give a deterministic slow git call and a timestamped one.
  git('config', 'alias.nap', '!sleep 1.2');
  git('config', 'alias.stamp', '!sh -c "date +%s%N; sleep 0.4; date +%s%N"');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  await resetAdmissionOffthread();
});

/** Count 20ms timer turns on THIS event loop while `job` is pending. */
async function loopTurnsDuring(job: Promise<unknown>): Promise<number> {
  let turns = 0;
  let done = false;
  const tick = () => {
    if (done) return;
    turns++;
    setTimeout(tick, 20);
  };
  setTimeout(tick, 20);
  await job;
  done = true;
  return turns;
}

describe('admission off-thread host (WI-10005223)', () => {
  it('resolves the unbundled tsx bootstrap from a source tree with no bundled worker', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(admissionWorkerEntry(here)).toBe(join(here, ADMISSION_WORKER_TSX_BOOTSTRAP));
  });

  it('keeps the caller event loop turning while a slow admission git call runs', async () => {
    await runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo }); // warm the worker
    const turns = await loopTurnsDuring(runAdmissionJob({ kind: 'git', argv: ['nap'], cwd: repo }));
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
    // ~60 turns ideal over 1.2s; a main-thread spawnSync yields 0.
    expect(turns).toBeGreaterThanOrEqual(15);
  }, 60_000);

  it('CONTROL: the same call inline blocks the loop, so the turn count can fail', async () => {
    configureAdmissionOffthread({ mode: 'inline' });
    const turns = await loopTurnsDuring(runAdmissionJob({ kind: 'git', argv: ['nap'], cwd: repo }));
    expect(admissionOffthreadStats().jobsInline).toBe(1);
    expect(turns).toBeLessThanOrEqual(2);
  });

  it('returns exactly what the inline builders return (git + containment)', async () => {
    const gitJob = { kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo } as const;
    const containmentJob = {
      kind: 'containment',
      paths: ['a.txt', 'missing.txt'],
      judgedSha: 'HEAD',
      root: repo,
      branch: 'staging',
    } as const;
    const [viaWorkerGit, viaWorkerContainment] = [
      await runAdmissionJob({ ...gitJob, argv: [...gitJob.argv] }),
      await runAdmissionJob({ ...containmentJob, paths: [...containmentJob.paths] }),
    ];
    expect(admissionOffthreadStats().jobsOnWorker).toBe(2);
    expect(viaWorkerGit).toEqual(executeAdmissionJob({ ...gitJob, argv: [...gitJob.argv] }));
    expect(viaWorkerContainment).toEqual(
      executeAdmissionJob({ ...containmentJob, paths: [...containmentJob.paths] }),
    );
    expect(viaWorkerContainment[0]).toMatchObject({ path: 'a.txt', containedInJudgedSha: true });
  }, 60_000);

  it('serializes jobs: a second admission job never starts before the first finishes', async () => {
    const [first, second] = await Promise.all([
      runAdmissionJob({ kind: 'git', argv: ['stamp'], cwd: repo }),
      runAdmissionJob({ kind: 'git', argv: ['stamp'], cwd: repo }),
    ]);
    const span = (out: string) => out.trim().split('\n').map((n) => BigInt(n));
    const [, firstEnd] = span(first.stdout);
    const [secondStart] = span(second.stdout);
    expect(secondStart >= firstEnd!).toBe(true);
  }, 60_000);

  it('rethrows a builder exception with its message and a worker-thread stack frame', async () => {
    const failing = runAdmissionJob({
      kind: 'admit',
      input: {
        root: repo,
        candidate: 'c'.repeat(40),
        repairHead: 'd'.repeat(40),
        paths: ['a.txt'],
        source: { ref: 'staging' },
        actor: 'test',
        nowMs: 0,
      },
      preflight: null,
    });
    await expect(failing).rejects.toThrow(/nowMs must be a positive timestamp/);
    await expect(failing).rejects.toHaveProperty('stack', expect.stringContaining('<admission worker thread>'));
    // The worker survives a job error and serves the next job.
    await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
      status: 0,
    });
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, loadFailures: 0 });
  }, 60_000);

  it('falls back inline — loudly — only when the worker cannot load', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureAdmissionOffthread({ workerPath: join(repo, 'no-such-worker.mjs') });
    const result = await runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo });
    expect(result).toEqual(executeAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo }));
    expect(admissionOffthreadStats()).toMatchObject({ loadFailures: 1, jobsInline: 1, jobsOnWorker: 0 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('running admission git INLINE'));
  }, 60_000);
});
