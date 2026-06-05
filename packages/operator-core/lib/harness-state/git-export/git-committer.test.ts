import { describe, it, expect, vi } from 'vitest';
import {
  commitHarnessState,
  makeDebouncedGitCommitter,
  gitExportCommitEnabled,
  type RunGit,
} from './git-committer';

/** A fake git that records every invocation and returns a scripted result. */
function fakeGit(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: { args: string[]; cwd: string }[] = [];
  const runGit: RunGit = async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runGit, calls };
}

describe('git-export committer (P-003b residue A)', () => {
  it('is a no-op when disabled — never invokes git', async () => {
    const { runGit, calls } = fakeGit({ code: 0 });
    const res = await commitHarnessState({ harnessRoot: '/r', enabled: false, runGit, log: () => {} });
    expect(res).toEqual({ committed: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('enabled: stages + commits ONLY .papercusp/state (scoped pathspec, never add -A)', async () => {
    const { runGit, calls } = fakeGit({ code: 0 });
    const res = await commitHarnessState({ harnessRoot: '/r', enabled: true, runGit, log: () => {} });
    expect(res).toEqual({ committed: true });
    expect(calls).toHaveLength(2);
    // add is path-scoped
    expect(calls[0].args).toEqual(['add', '--', '.papercusp/state']);
    expect(calls[0].cwd).toBe('/r');
    // commit is path-scoped + no-verify
    expect(calls[1].args[0]).toBe('commit');
    expect(calls[1].args).toContain('--no-verify');
    expect(calls[1].args.slice(-2)).toEqual(['--', '.papercusp/state']);
    // NEVER a broad add nor a push
    for (const c of calls) {
      expect(c.args).not.toContain('-A');
      expect(c.args).not.toContain('.');
      expect(c.args[0]).not.toBe('push');
    }
  });

  it('treats "nothing to commit" as a normal non-error outcome', async () => {
    // git add succeeds; git commit returns non-zero with the nothing-to-commit message.
    let call = 0;
    const runGit: RunGit = async () => {
      call += 1;
      if (call === 1) return { code: 0, stdout: '', stderr: '' }; // add
      return { code: 1, stdout: 'nothing to commit, working tree clean', stderr: '' }; // commit
    };
    const res = await commitHarnessState({ harnessRoot: '/r', enabled: true, runGit, log: () => {} });
    expect(res).toEqual({ committed: false, reason: 'nothing-to-commit' });
  });

  it('reports a real commit failure (non-zero, not the nothing-to-commit case)', async () => {
    let call = 0;
    const runGit: RunGit = async () => {
      call += 1;
      if (call === 1) return { code: 0, stdout: '', stderr: '' };
      return { code: 128, stdout: '', stderr: 'fatal: unable to write' };
    };
    const res = await commitHarnessState({ harnessRoot: '/r', enabled: true, runGit, log: () => {} });
    expect(res).toEqual({ committed: false, reason: 'commit-failed' });
  });

  it('never pushes (no git path here can reach a remote)', async () => {
    const { runGit, calls } = fakeGit({ code: 0 });
    await commitHarnessState({ harnessRoot: '/r', enabled: true, runGit, log: () => {} });
    expect(calls.every((c) => c.args[0] !== 'push' && !c.args.includes('origin'))).toBe(true);
  });

  it('gitExportCommitEnabled reflects the env flag (default OFF)', () => {
    const prev = process.env.PAPERCUSP_GIT_EXPORT_COMMIT;
    try {
      delete process.env.PAPERCUSP_GIT_EXPORT_COMMIT;
      expect(gitExportCommitEnabled()).toBe(false);
      process.env.PAPERCUSP_GIT_EXPORT_COMMIT = '1';
      expect(gitExportCommitEnabled()).toBe(true);
      process.env.PAPERCUSP_GIT_EXPORT_COMMIT = '0';
      expect(gitExportCommitEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_GIT_EXPORT_COMMIT;
      else process.env.PAPERCUSP_GIT_EXPORT_COMMIT = prev;
    }
  });

  it('debounced committer coalesces a burst into ONE commit', async () => {
    vi.useFakeTimers();
    try {
      const { runGit, calls } = fakeGit({ code: 0 });
      const commit = makeDebouncedGitCommitter('/r', { debounceMs: 1000, enabled: true, runGit, log: () => {} });
      commit(['a.md']);
      commit(['b.md']);
      commit(['c.md']); // three rapid bursts within the window
      expect(calls).toHaveLength(0); // nothing yet (debounced)
      await vi.advanceTimersByTimeAsync(1000);
      // exactly one add + one commit for the coalesced burst
      const adds = calls.filter((c) => c.args[0] === 'add');
      const commits = calls.filter((c) => c.args[0] === 'commit');
      expect(adds).toHaveLength(1);
      expect(commits).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
