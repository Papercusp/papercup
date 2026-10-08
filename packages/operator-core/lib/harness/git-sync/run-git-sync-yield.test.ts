/**
 * WI-10007606: runGitSync's cooperative yield to a waiting exclusive (dev:restart's
 * git-sync restart barrier). One papercusp pass held the shared barrier for 11+ minutes
 * under load while dev:restart's drain is capped at 120s, so bg-host could not be
 * restarted at all. These tests pin the yield contract:
 *   - the probe runs only at submodule-batch boundaries and before pointer-bump, never
 *     while a git command is in flight;
 *   - a yield stops the walk (no further submodule or superproject git work) and throws
 *     GitSyncYieldError carrying where it stopped;
 *   - a crash-replay of the checkpointed submodule phase yields again rather than
 *     treating the partial walk as a complete phase;
 *   - a throwing probe fails OPEN (the pass completes).
 */
import { describe, it, expect } from 'vitest';
import { runGitSync, GitSyncYieldError, type RunGit, type GitSyncStepRunner } from './run-git-sync';

const SUBMODULES = ['libs/s0', 'libs/s1', 'libs/s2', 'libs/s3', 'libs/s4', 'libs/s5', 'libs/s6', 'libs/s7', 'libs/s8'];

function stripConfigFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

/** A hermetic git fake that records every call and how many are in flight. */
function recordingGit() {
  const calls: Array<{ cwd: string; command: string }> = [];
  const state = { inFlight: 0 };
  const run: RunGit = async (args, cwd) => {
    state.inFlight++;
    try {
      const command = stripConfigFlags(args).join(' ');
      calls.push({ cwd, command });
      // Let sibling batch members genuinely overlap so an in-flight probe would be visible.
      await new Promise((resolve) => setImmediate(resolve));
      if (command.startsWith('symbolic-ref')) return { code: 0, stdout: 'main', stderr: '' };
      if (command.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    } finally {
      state.inFlight--;
    }
  };
  return { run, calls, state };
}

const SUPERPROJECT_WRITES = /^(add|commit|write-tree|read-tree|update-index)\b/;

describe('WI-10007606 runGitSync cooperative yield', () => {
  it('yields at the next submodule-batch boundary and runs no further git work', async () => {
    const git = recordingGit();
    const probesWithGitInFlight: number[] = [];
    let probes = 0;
    const shouldYield = async (): Promise<string | null> => {
      probes++;
      probesWithGitInFlight.push(git.state.inFlight);
      // Batches are 4 wide: 0-3, 4-7, 8. Yield before the THIRD batch.
      return probes === 3 ? 'exclusive git-sync drain requested by su-test' : null;
    };

    const err = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      shouldYield,
      log: () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSyncYieldError);
    const y = err as GitSyncYieldError;
    expect(y.name).toBe('GitSyncYieldError');
    expect(y.boundary).toBe('submodule-batch');
    expect(y.submodulesSynced).toBe(8);
    expect(y.submodulesTotal).toBe(9);
    expect(y.reason).toBe('exclusive git-sync drain requested by su-test');

    // The probe never ran while a git command was executing.
    expect(probesWithGitInFlight).toEqual([0, 0, 0]);
    // The yielded batch never started, and the superproject was never staged/committed.
    expect(git.calls.some((c) => c.cwd === '/fake/libs/s8')).toBe(false);
    expect(git.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('yields before the pointer-bump phase once every submodule has synced', async () => {
    const git = recordingGit();
    let probes = 0;
    const err = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: ['libs/a', 'libs/b'],
      config: { push: false, pushSubmoduleOrigins: false },
      // Probe 1 = the only batch boundary; probe 2 = before pointer-bump.
      shouldYield: async () => (++probes === 2 ? 'restart waiting' : null),
      log: () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSyncYieldError);
    expect((err as GitSyncYieldError).boundary).toBe('before-pointer-bump');
    expect((err as GitSyncYieldError).submodulesSynced).toBe(2);
    expect(git.calls.some((c) => c.cwd === '/fake/libs/b')).toBe(true);
    expect(git.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('a crash-replay of the checkpointed submodule phase yields again instead of bumping pointers', async () => {
    const recorded = new Map<string, unknown>();
    const recordingStep: GitSyncStepRunner = async (name, fn) => {
      const out = await fn();
      recorded.set(name, JSON.parse(JSON.stringify(out)));
      return out;
    };
    const first = recordingGit();
    const firstErr = await runGitSync('test', {
      repoPath: '/fake',
      runGit: first.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      step: recordingStep,
      shouldYield: async () => 'restart waiting',
      log: () => {},
    }).catch((e: unknown) => e);
    expect(firstErr).toBeInstanceOf(GitSyncYieldError);
    expect(recorded.has('git-sync:submodules')).toBe(true);

    // DBOS recovery replays a recorded step's output WITHOUT calling its body, and the
    // live probe may now say "nobody is waiting". The partial walk must still not be
    // treated as a complete phase.
    const replayStep: GitSyncStepRunner = async <T,>(name: string, fn: () => Promise<T>): Promise<T> =>
      recorded.has(name) ? (recorded.get(name) as T) : fn();
    const replay = recordingGit();
    const replayErr = await runGitSync('test', {
      repoPath: '/fake',
      runGit: replay.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      step: replayStep,
      shouldYield: async () => null,
      log: () => {},
    }).catch((e: unknown) => e);
    expect(replayErr).toBeInstanceOf(GitSyncYieldError);
    expect((replayErr as GitSyncYieldError).submodulesSynced).toBe(0);
    expect(replay.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('a throwing probe fails open: the pass completes and the failure is logged', async () => {
    const git = recordingGit();
    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: ['libs/a'],
      config: { push: false, pushSubmoduleOrigins: false },
      shouldYield: async () => {
        throw new Error('pg down');
      },
      log: (m) => logs.push(m),
    });
    // Resolved (no GitSyncYieldError) and walked both the submodule and the superproject.
    expect(out.status).toBeTypeOf('string');
    expect(git.calls.some((c) => c.cwd === '/fake/libs/a')).toBe(true);
    expect(git.calls.some((c) => c.cwd === '/fake' && c.command.startsWith('status'))).toBe(true);
    expect(logs.join('\n')).toContain('shouldYield probe failed (pg down)');
  });
});
