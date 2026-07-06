import { describe, it, expect } from 'vitest';
import { listStashEntries, newStashEntries, type RunGit, type StashEntry } from './run-git-sync';

// WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
// shared canonical staging tree and it sat there silently, LOOKING like vanished
// work). The detection + escalation logic (checkForNewStashes in git-sync-action.ts)
// was implemented and wired in, but the two pure primitives it's built on
// (listStashEntries / newStashEntries) had zero direct test coverage — this file
// closes that gap. (The escalation itself has already been proven live: it fired a
// real `🚨 NEW git-stash entry` broadcast in production on 2026-07-05.)

describe('listStashEntries — parses `git stash list --format=%H%x1f%s`', () => {
  it('parses multiple entries, splitting sha/subject on the \\x1f separator', async () => {
    const runGit: RunGit = async (args) => {
      expect(args).toEqual(['stash', 'list', '--format=%H%x1f%s']);
      return {
        code: 0,
        stdout: 'aaa111\x1fWIP on staging: quick fix\nbbb222\x1fon staging: testing something\n',
        stderr: '',
      };
    };
    const entries = await listStashEntries(runGit, '/repo');
    expect(entries).toEqual([
      { sha: 'aaa111', subject: 'WIP on staging: quick fix' },
      { sha: 'bbb222', subject: 'on staging: testing something' },
    ]);
  });

  it('returns an empty list when there are no stashes', async () => {
    const runGit: RunGit = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await listStashEntries(runGit, '/repo')).toEqual([]);
  });

  it('fails open (empty list, never throws) when git exits non-zero', async () => {
    const runGit: RunGit = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await expect(listStashEntries(runGit, '/not-a-repo')).resolves.toEqual([]);
  });

  it('drops a line with no parseable sha (defensive against odd output)', async () => {
    const runGit: RunGit = async () => ({ code: 0, stdout: '\n   \nccc333\x1fok\n', stderr: '' });
    expect(await listStashEntries(runGit, '/repo')).toEqual([{ sha: 'ccc333', subject: 'ok' }]);
  });
});

describe('newStashEntries — pure diff against a known-SHA baseline', () => {
  const current: StashEntry[] = [
    { sha: 'aaa', subject: 'old, already known' },
    { sha: 'bbb', subject: 'brand new' },
  ];

  it('returns only entries whose sha is NOT in the known set', () => {
    expect(newStashEntries(current, ['aaa'])).toEqual([{ sha: 'bbb', subject: 'brand new' }]);
  });

  it('returns everything when the known baseline is empty (first-ever check)', () => {
    expect(newStashEntries(current, [])).toEqual(current);
  });

  it('returns nothing when every current entry is already known (no alert-worthy change)', () => {
    expect(newStashEntries(current, ['aaa', 'bbb', 'a-popped-one-not-present-anymore'])).toEqual([]);
  });
});
