import { describe, it, expect } from 'vitest';
import {
  listStashEntries,
  newStashEntries,
  partitionStashEntriesByAge,
  describeStashAge,
  STASH_RECENT_WINDOW_MS,
  type RunGit,
  type StashEntry,
} from './run-git-sync';

// WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
// shared canonical staging tree and it sat there silently, LOOKING like vanished
// work). The detection + escalation logic (checkForNewStashes in git-sync-action.ts)
// was implemented and wired in, but the two pure primitives it's built on
// (listStashEntries / newStashEntries) had zero direct test coverage — this file
// closes that gap. (The escalation itself has already been proven live: it fired a
// real `🚨 NEW git-stash entry` broadcast in production on 2026-07-05.)
//
// EI-19449313204576061 (2026-08-03) extends this file to the FALSE-NEW class: the
// detector broadcast two stashes aged 12 and 13 WEEKS as "🚨 NEW", because "not in my
// baseline" was rendered as "new" — a claim about creation time it had never observed.
// The age primitives below are what let it report what it actually saw.

const at = (iso: string): StashEntry => ({ sha: iso, subject: 's', createdAt: iso });

describe('listStashEntries — parses `git stash list --format=%H%x1f%cI%x1f%s`', () => {
  it('parses multiple entries, splitting sha/date/subject on the \\x1f separator', async () => {
    const runGit: RunGit = async (args) => {
      expect(args).toEqual(['stash', 'list', '--format=%H%x1f%cI%x1f%s']);
      return {
        code: 0,
        stdout:
          'aaa111\x1f2026-08-03T10:00:00-04:00\x1fWIP on staging: quick fix\n' +
          'bbb222\x1f2026-05-01T02:32:43-04:00\x1fon staging: testing something\n',
        stderr: '',
      };
    };
    const entries = await listStashEntries(runGit, '/repo');
    expect(entries).toEqual([
      { sha: 'aaa111', createdAt: '2026-08-03T10:00:00-04:00', subject: 'WIP on staging: quick fix' },
      { sha: 'bbb222', createdAt: '2026-05-01T02:32:43-04:00', subject: 'on staging: testing something' },
    ]);
  });

  it('keeps a subject that itself contains the separator (rejoins the tail)', async () => {
    const runGit: RunGit = async () => ({
      code: 0,
      stdout: 'ddd444\x1f2026-08-03T10:00:00-04:00\x1fweird\x1fsubject\n',
      stderr: '',
    });
    expect(await listStashEntries(runGit, '/repo')).toEqual([
      { sha: 'ddd444', createdAt: '2026-08-03T10:00:00-04:00', subject: 'weird\x1fsubject' },
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
    const runGit: RunGit = async () => ({
      code: 0,
      stdout: '\n   \nccc333\x1f2026-08-03T10:00:00-04:00\x1fok\n',
      stderr: '',
    });
    expect(await listStashEntries(runGit, '/repo')).toEqual([
      { sha: 'ccc333', createdAt: '2026-08-03T10:00:00-04:00', subject: 'ok' },
    ]);
  });

  it('tolerates a missing date field rather than dropping the entry', async () => {
    const runGit: RunGit = async () => ({ code: 0, stdout: 'eee555\n', stderr: '' });
    expect(await listStashEntries(runGit, '/repo')).toEqual([{ sha: 'eee555', createdAt: '', subject: '' }]);
  });
});

describe('newStashEntries — pure diff against a known-SHA baseline', () => {
  const current: StashEntry[] = [
    { sha: 'aaa', subject: 'old, already known', createdAt: '2026-05-01T00:00:00Z' },
    { sha: 'bbb', subject: 'brand new', createdAt: '2026-08-03T00:00:00Z' },
  ];

  it('returns only entries whose sha is NOT in the known set', () => {
    expect(newStashEntries(current, ['aaa'])).toEqual([current[1]]);
  });

  // NOTE: this remains the correct contract for the PURE helper — "diff against the set
  // I was given". The EI-19449313204576061 bug was in the CALLER, which passed [] for a
  // baseline that had never been RECORDED (SQL NULL) and thus treated a first
  // observation as "everything is new". See git-sync-action.ts:checkForNewStashes.
  it('returns everything when the known baseline is empty (first-ever check)', () => {
    expect(newStashEntries(current, [])).toEqual(current);
  });

  it('returns nothing when every current entry is already known (no alert-worthy change)', () => {
    expect(newStashEntries(current, ['aaa', 'bbb', 'a-popped-one-not-present-anymore'])).toEqual([]);
  });
});

// ── EI-19449313204576061: "not in my baseline" ≠ "new" ────────────────────────────
describe('partitionStashEntriesByAge — separates genuinely-recent from merely-newly-visible', () => {
  const now = Date.parse('2026-08-03T16:17:00Z');

  it('THE REGRESSION: the two real 2026-05 stashes are pre-existing, not recent', () => {
    // The exact entries that were broadcast fleet-wide as "🚨 NEW" on 2026-08-03.
    const entries = [at('2026-05-11T04:47:31-04:00'), at('2026-05-01T02:32:43-04:00')];
    const { recent, preExisting } = partitionStashEntriesByAge(entries, now);
    expect(recent).toEqual([]);
    expect(preExisting).toEqual(entries);
  });

  it('classifies a stash created minutes ago as recent (the EI-7685 case that matters)', () => {
    const { recent, preExisting } = partitionStashEntriesByAge([at('2026-08-03T16:05:00Z')], now);
    expect(recent).toHaveLength(1);
    expect(preExisting).toEqual([]);
  });

  it('treats an entry with no/unparseable date as RECENT — fails toward surfacing', () => {
    const noDate: StashEntry = { sha: 'x', subject: 's', createdAt: '' };
    const bogus: StashEntry = { sha: 'y', subject: 's', createdAt: 'not-a-date' };
    const { recent, preExisting } = partitionStashEntriesByAge([noDate, bogus], now);
    expect(recent).toEqual([noDate, bogus]);
    expect(preExisting).toEqual([]);
  });

  it('is inclusive at exactly the window boundary (boundary belongs to recent)', () => {
    const boundary = new Date(now - STASH_RECENT_WINDOW_MS).toISOString();
    const justPast = new Date(now - STASH_RECENT_WINDOW_MS - 1000).toISOString();
    expect(partitionStashEntriesByAge([at(boundary)], now).recent).toHaveLength(1);
    expect(partitionStashEntriesByAge([at(justPast)], now).preExisting).toHaveLength(1);
  });

  it('splits a mixed set both ways in one pass', () => {
    const old1 = at('2026-05-01T02:32:43-04:00');
    const fresh1 = at('2026-08-03T15:00:00Z');
    const { recent, preExisting } = partitionStashEntriesByAge([old1, fresh1], now);
    expect(recent).toEqual([fresh1]);
    expect(preExisting).toEqual([old1]);
  });

  it('handles an empty input without inventing entries', () => {
    expect(partitionStashEntriesByAge([], now)).toEqual({ recent: [], preExisting: [] });
  });
});

describe('describeStashAge — renders the fact whose absence made a 13-week stash read as urgent', () => {
  const now = Date.parse('2026-08-03T16:17:00Z');

  it('reports day-granularity age for an old stash, including its creation date', () => {
    expect(describeStashAge(at('2026-05-01T02:32:43-04:00'), now)).toBe('created 2026-05-01, 94d old');
  });

  it('reports hour-granularity age for a stash under a day old', () => {
    expect(describeStashAge(at('2026-08-03T10:00:00Z'), now)).toBe('created 2026-08-03, 6h old');
  });

  it('says "unknown age" rather than fabricating a date when git gave none', () => {
    expect(describeStashAge({ sha: 'x', subject: 's', createdAt: '' }, now)).toBe('unknown age');
    expect(describeStashAge({ sha: 'x', subject: 's', createdAt: 'garbage' }, now)).toBe('unknown age');
  });
});
