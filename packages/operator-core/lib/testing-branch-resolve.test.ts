/**
 * testing-branch-resolve.test.ts — the fail-soft git-context resolver (D-007).
 *
 * Contract under test: resolveGitContext NEVER throws, maps a detached HEAD to
 * branch:null, returns {branch:null, commit:null} on any git failure, and caches
 * the result for 30s (cleared by _resetGitContextCache). exec + the workspace-root
 * resolver are mocked so the test is deterministic + offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver shells `git` via node:child_process exec; mock it so no real git runs.
const execMock = vi.fn();
vi.mock('node:child_process', () => ({ exec: (...a: unknown[]) => execMock(...a) }));
vi.mock('./testing-domain-glob', () => ({ inferWorkspaceRoot: () => '/fake/root' }));

import { resolveGitContext, _resetGitContextCache } from './testing-branch-resolve';

/** Configure exec to answer abbrev-ref with `branch` and rev-parse HEAD with `commit`. */
function gitAnswers(branch: string | null, commit: string | null, err = false) {
  execMock.mockImplementation((cmd: string, _opts: unknown, cb: (e: Error | null, out: string) => void) => {
    if (err) cb(new Error('git not found'), '');
    else if (cmd.includes('abbrev-ref')) cb(null, `${branch ?? ''}\n`);
    else cb(null, `${commit ?? ''}\n`);
    return { on: vi.fn() };
  });
}

beforeEach(() => {
  _resetGitContextCache();
  execMock.mockReset();
});
afterEach(() => {
  _resetGitContextCache();
});

describe('resolveGitContext — fail-soft + caching', () => {
  it('returns the trimmed branch + commit on success', async () => {
    gitAnswers('main', 'abc123def');
    expect(await resolveGitContext()).toEqual({ branch: 'main', commit: 'abc123def' });
  });

  it('maps a detached HEAD (branch === "HEAD") to branch:null but keeps the commit', async () => {
    gitAnswers('HEAD', 'deadbeef');
    expect(await resolveGitContext()).toEqual({ branch: null, commit: 'deadbeef' });
  });

  it('returns {branch:null, commit:null} on a git failure — never throws', async () => {
    gitAnswers(null, null, /* err */ true);
    await expect(resolveGitContext()).resolves.toEqual({ branch: null, commit: null });
  });

  it('treats an empty commit output as null', async () => {
    gitAnswers('feature/x', '');
    expect(await resolveGitContext()).toEqual({ branch: 'feature/x', commit: null });
  });

  it('caches within the TTL — a second call does not re-shell git', async () => {
    gitAnswers('main', 'c1');
    const first = await resolveGitContext();
    const callsAfterFirst = execMock.mock.calls.length;

    // Change the git answers; the cached value must be returned unchanged.
    gitAnswers('other', 'c2');
    const second = await resolveGitContext();

    expect(second).toEqual(first);
    expect(execMock.mock.calls.length).toBe(callsAfterFirst); // no further exec calls
  });

  it('re-resolves after _resetGitContextCache', async () => {
    gitAnswers('main', 'c1');
    await resolveGitContext();
    _resetGitContextCache();
    gitAnswers('release', 'c2');
    expect(await resolveGitContext()).toEqual({ branch: 'release', commit: 'c2' });
  });
});
