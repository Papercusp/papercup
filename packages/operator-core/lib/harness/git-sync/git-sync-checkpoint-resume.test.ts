/**
 * WI-1416 (bg-host-freeze-eventloop-stall P-006): the CHECKPOINTED git-sync pipeline,
 * proven against real git fixtures (bare origins + a working clone with a submodule).
 *
 * THE WI-1415 FAILURE MODE: handleGitSync ran as ONE opaque DBOS step, so the executor
 * reaper cancelled+requeued any fire whose first step outlived its 90s orphan window —
 * a restart-from-scratch loop (~1 commit/40min). The pipeline now checkpoints per phase
 * (`git-sync:submodules` → `git-sync:pointer-bump` → `git-sync:push`) via the
 * RunGitSyncOpts.step seam. This suite pins the two properties the split must hold:
 *
 *   RESUME+COMMIT, NOT LOOP — a fire killed right after the submodules checkpoint (the
 *   reaper's cancel) leaves its submodule work durable; the requeued fire completes the
 *   superproject pointer-bump + push WITHOUT redoing (or double-committing) the
 *   submodule work.
 *
 *   REPLAY-SAFE — a DBOS resume that replays recorded step outputs (full or partial)
 *   never double-commits: a replayed commit checkpoint is never re-executed, and a
 *   re-executed push on an already-pushed HEAD is `Everything up-to-date`.
 *
 * Plus the WI-1416 hang guard: a wedged git subprocess fails FAST with a recorded
 * timeout error instead of hanging the fire into a reap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// WI-6824: runGitSync's `log` sink defaults to console.warn (it used to be a no-op, which is
// why a real ~10h git-sync fault left zero trace in journald). This suite deliberately drives
// blocked/deferred submodule paths, which narrate — capture the expected output.
let gitSyncWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  gitSyncWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  gitSyncWarnSpy?.mockRestore();
  gitSyncWarnSpy = undefined;
});
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGitSync,
  runGitBounded,
  gitTimeoutMsFor,
  gitHardTimeoutMsFor,
  gitSyncSidecarEnabled,
  type GitSyncStepRunner,
  type RunGit,
} from './run-git-sync';

/** Run git synchronously for test setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync checkpoint test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

/** A step runner that records executed step names/outputs, optionally REPLAYS
 *  pre-recorded outputs (a DBOS resume: recorded steps return their checkpoint
 *  without executing), and optionally ABORTS right after a named step completes
 *  (the executor reaper cancelling the workflow post-checkpoint). */
function makeStepRunner(o: {
  names: string[];
  outputs?: Map<string, unknown>;
  replay?: Map<string, unknown>;
  abortAfter?: string;
}): GitSyncStepRunner {
  return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (o.replay?.has(name)) {
      o.names.push(`${name} (replayed)`);
      return o.replay.get(name) as T;
    }
    const out = await fn();
    o.names.push(name);
    o.outputs?.set(name, out);
    if (o.abortAfter === name) throw new Error('simulated reap: workflow cancelled after checkpoint');
    return out;
  };
}

describe('WI-1416 checkpointed pipeline (real git, submodule)', () => {
  let root: string;
  let superOrigin: string;
  let subOrigin: string;
  let repo: string;

  // file:// submodule add/update is blocked by default (CVE) — allow it in setup.
  const allowFile = ['-c', 'protocol.file.allow=always'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-ckpt-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const revCount = (bare: string): number => Number(git(bare, 'rev-list', '--count', 'main'));

  it('ACCEPTANCE: a fire reaped after the submodules checkpoint RESUMES+COMMITS on the requeued fire — no restart loop, no double-commit', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    // FIRE 1 — cancelled (reaped) right after the `git-sync:submodules` checkpoint.
    const names1: string[] = [];
    await expect(
      runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: names1, abortAfter: 'git-sync:submodules' }) }),
    ).rejects.toThrow(/simulated reap/);
    expect(names1).toEqual(['git-sync:submodules']);
    // The checkpointed phase's work is DURABLE: the submodule commit reached its origin…
    expect(git(subOrigin, 'log', '--format=%s', 'main')).toMatch(/auto-commit ckpt/);
    const subCountAfterFire1 = revCount(subOrigin);
    // …while the superproject (killed before its phases) has NOT moved.
    expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit ckpt/);
    const superCountAfterFire1 = revCount(superOrigin);

    // FIRE 2 — the requeued fire (a NEW workflow, from the top). It must CONVERGE:
    // finish the superproject pointer-bump + push, and NOT re-commit the submodule.
    const names2: string[] = [];
    const out = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: names2 }) });
    expect(names2).toEqual(['git-sync:submodules', 'git-sync:pointer-bump', 'git-sync:push']);
    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toContain('superproject');
      expect(out.pushed).not.toContain('libs/sub'); // nothing redone — fire 1's push stands
    }
    // NO double-commit: the submodule origin gained ZERO commits on the requeued fire.
    expect(revCount(subOrigin)).toBe(subCountAfterFire1);
    // The superproject converged: exactly one new commit, whose gitlink resolves remotely.
    expect(revCount(superOrigin)).toBe(superCountAfterFire1 + 1);
    const subHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(subHead);
    expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
  });

  it('ACCEPTANCE: a FULL DBOS replay (all step outputs recorded) re-executes NOTHING and does not double-commit', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    const outputs = new Map<string, unknown>();
    const first = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: [], outputs }) });
    expect(first.status).toBe('synced');
    const subCount = revCount(subOrigin);
    const superCount = revCount(superOrigin);

    // The resume: every phase replays its checkpoint. Inject a runGit that FAILS the
    // test if the pipeline touches git at all outside the replayed steps.
    const forbiddenRunGit: RunGit = async (args) => {
      throw new Error(`replay must not execute git (got: git ${args.join(' ')})`);
    };
    const names: string[] = [];
    const replayed = await runGitSync('ckpt', {
      repoPath: repo,
      runGit: forbiddenRunGit,
      step: makeStepRunner({ names, replay: outputs }),
    });
    expect(names).toEqual([
      'git-sync:submodules (replayed)',
      'git-sync:pointer-bump (replayed)',
      'git-sync:push (replayed)',
    ]);
    // The replayed pass reconstructs the SAME outcome from checkpoints alone…
    expect(replayed).toEqual(first);
    // …and made zero new commits anywhere.
    expect(revCount(subOrigin)).toBe(subCount);
    expect(revCount(superOrigin)).toBe(superCount);
  });

  it('ACCEPTANCE: a PARTIAL resume (commit checkpointed, push re-executed) never double-commits — the re-run push is a no-op', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    const outputs = new Map<string, unknown>();
    const first = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: [], outputs }) });
    expect(first.status).toBe('synced');
    const subCount = revCount(subOrigin);
    const superCount = revCount(superOrigin);

    // Resume with the submodules + pointer-bump checkpoints only: the push step
    // RE-EXECUTES against real git. The replayed commit checkpoint claims
    // committedLocal=true — the re-run push must find `Everything up-to-date`,
    // not mint a second commit.
    const replay = new Map<string, unknown>([
      ['git-sync:submodules', outputs.get('git-sync:submodules')],
      ['git-sync:pointer-bump', outputs.get('git-sync:pointer-bump')],
    ]);
    const names: string[] = [];
    const resumed = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names, replay }) });
    expect(names).toEqual([
      'git-sync:submodules (replayed)',
      'git-sync:pointer-bump (replayed)',
      'git-sync:push',
    ]);
    expect(resumed.status).toBe('synced'); // committedLocal from the checkpoint
    if (resumed.status === 'synced') {
      // The outcome reports the WHOLE fire's work: the replayed submodule checkpoint's
      // push, but NOT a fresh superproject push — the re-run found nothing to move.
      expect(resumed.pushed).toEqual(['libs/sub']);
    }
    expect(revCount(subOrigin)).toBe(subCount);
    expect(revCount(superOrigin)).toBe(superCount);
  });

  it('blocked submodules defer the superproject PUSH: pointer-bump IS minted, the push checkpoint never is', async () => {
    // Dirty the submodule, then break its origin so its phase errors (GAP-4 shape).
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');
    git(join(repo, 'libs/sub'), 'remote', 'set-url', 'origin', join(root, 'gone.git'));

    const names: string[] = [];
    const out = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names }) });
    expect(out.status).toBe('error');
    // EI-20182436053613562: the local commit ALWAYS runs, so its phase is a genuine
    // completed step and is checkpointed as one — a crashed fire that resumes replays it
    // instead of re-committing. Only the NETWORK half is withheld while a submodule is
    // unreconciled, so `git-sync:push` is still never minted.
    expect(names).toEqual(['git-sync:submodules', 'git-sync:pointer-bump']);
    expect(names).not.toContain('git-sync:push');
    expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit ckpt/);
    // ...and the superproject's own work is safely committed locally rather than stranded.
    expect(git(repo, 'log', '--format=%s', 'HEAD')).toMatch(/auto-commit ckpt/);
  });
});

describe('WI-1416 git subprocess hang guard', () => {
  it('kills a wedged git subprocess at the ceiling and reports a recorded timeout error (fail fast, not a silent reap)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-hang-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    try {
      // Do not depend on `git credential fill` blocking: newer Git builds reject an
      // empty credential request immediately with 128. A PATH-local fake is the
      // deterministic equivalent of a git child wedged before producing output.
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nexec sleep 60\n');
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';

      const started = Date.now();
      const r = await runGitBounded(['status', '--porcelain'], cwd, 300);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(r.code).toBe(-1);
      expect(r.stderr).toMatch(/timed out after 300ms — killed by the git-sync hang guard/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('classifies network subcommands (fetch/push) under the network ceiling, everything else under the local one — leading flags skipped', () => {
    const network = gitTimeoutMsFor(['push', 'origin', 'HEAD:main']);
    const local = gitTimeoutMsFor(['status', '--porcelain']);
    expect(network).toBe(4 * 60_000);
    expect(local).toBe(6 * 60_000);
    expect(gitTimeoutMsFor(['-c', 'x=y', 'fetch', 'origin'])).toBe(network);
    expect(gitTimeoutMsFor(['submodule', 'status', '--recursive'])).toBe(local);
    expect(gitHardTimeoutMsFor(['fetch', 'origin'], network)).toBe(60 * 60_000);
    expect(gitHardTimeoutMsFor(['status'], local)).toBe(local);
  });

  it('refreshes the network idle deadline on forced git progress, allowing a healthy fetch to outlive the old wall clock', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-progress-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    const oldHardTimeout = process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
    try {
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      // WI-38223 — TIMING BUDGET, do not re-tighten. This test asserts a REFRESH property, so
      // it needs the child to outlive the idle deadline; that only works if the deadline sits
      // comfortably ABOVE the inter-output gap and comfortably BELOW the child's total runtime.
      // The original 80ms gap against a 120ms deadline left 40ms for scheduler jitter and went
      // red on a box running six concurrent vitest workers (the guard killed a healthy child,
      // so `r.code` was -1). Budget now: 50ms gap · 300ms idle deadline · ~500ms total.
      //   gap 50ms  vs deadline 300ms -> 250ms of jitter tolerance (a 6x ratio)
      //   total 500ms vs deadline 300ms -> STILL FALSIFIABLE: drop the refresh and the child is
      //   killed at 300ms, 200ms short of finishing, so a real regression still fails here.
      // Load only stretches the total, which strengthens falsifiability rather than eroding it.
      writeFileSync(
        fakeGit,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/argv"\ni=0\nwhile test "$i" -lt 10; do echo "progress $i" >&2; sleep 0.05; i=$((i + 1)); done\n',
      );
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';
      // Above the ~500ms total with room for the whole run to stretch several-fold under load.
      process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = '5000';

      const started = Date.now();
      const r = await runGitBounded(['fetch', 'origin', 'main'], cwd, 300);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('progress 9');
      expect(readFileSync(join(cwd, 'argv'), 'utf8').split('\n')).toContain('--progress');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      if (oldHardTimeout === undefined) delete process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = oldHardTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('still kills an endlessly-chatty network child at the independent hard ceiling', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-hard-timeout-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    const oldHardTimeout = process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
    try {
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nwhile :; do echo progress >&2; sleep 0.05; done\n');
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';
      process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = '350';

      const r = await runGitBounded(['fetch', 'origin', 'main'], cwd, 120);
      expect(r.code).toBe(-1);
      expect(r.stderr).toMatch(/exceeded the 350ms hard ceiling despite output progress/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      if (oldHardTimeout === undefined) delete process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = oldHardTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('routes git through the sidecar only on the bg-host opt-in, never inside the sidecar itself', () => {
    expect(gitSyncSidecarEnabled({ PAPERCUSP_SPAWNER_SIDECAR: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      gitSyncSidecarEnabled({
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      gitSyncSidecarEnabled({
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(gitSyncSidecarEnabled({ PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
