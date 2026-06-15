// @vitest-environment jsdom
//
// AdvGitGraphPanel — the /adv Git dock commit-graph panel. The component itself
// is a heavy RichGrid + virtualizer + git-graph-lib shell (→ e2e); its testable
// surface is the pure presentation helpers (formatAge / refClass / refLabel /
// matchesCommit), which are extracted + exported and tested branch-by-branch.

import { describe, expect, it, vi } from 'vitest';
import { formatAge, refClass, refLabel, matchesCommit } from './AdvGitGraphPanel';
import type { LaidOutCommit } from '@papercusp/git-graph';

function commit(over: Partial<LaidOutCommit> = {}): LaidOutCommit {
  return {
    sha: 'abc123',
    parents: [],
    subject: 'init',
    author: 'Avi',
    ts: Date.now(),
    refs: [],
    lane: 0,
    ...over,
  };
}

describe('formatAge', () => {
  it('returns "just now" under a minute', () => {
    expect(formatAge(Date.now() - 10_000)).toBe('just now');
  });
  it('formats minutes, hours, and days', () => {
    const now = Date.now();
    expect(formatAge(now - 5 * 60_000)).toBe('5m ago');
    expect(formatAge(now - 3 * 3_600_000)).toBe('3h ago');
    expect(formatAge(now - 2 * 86_400_000)).toBe('2d ago');
  });
  it('clamps a future timestamp to "just now" (never negative)', () => {
    expect(formatAge(Date.now() + 60_000)).toBe('just now');
  });
  it('falls back to a calendar date past ~30 days', () => {
    const old = Date.now() - 60 * 86_400_000;
    // not one of the relative buckets → a localized month/day string
    expect(formatAge(old)).not.toMatch(/ago|just now/);
  });
});

describe('refClass', () => {
  it('classifies HEAD and HEAD -> as head', () => {
    expect(refClass('HEAD')).toBe('head');
    expect(refClass('HEAD -> main')).toBe('head');
  });
  it('classifies a tag: prefix as tag', () => {
    expect(refClass('tag: v1.0')).toBe('tag');
  });
  it('classifies everything else as branch', () => {
    expect(refClass('origin/main')).toBe('branch');
  });
});

describe('refLabel', () => {
  it('strips the tag: prefix', () => {
    expect(refLabel('tag: v1.0')).toBe('v1.0');
  });
  it('prettifies the HEAD -> arrow', () => {
    expect(refLabel('HEAD -> main')).toBe('HEAD → main');
  });
  it('leaves a plain branch ref unchanged', () => {
    expect(refLabel('feature/x')).toBe('feature/x');
  });
});

describe('matchesCommit', () => {
  const c = commit({ sha: 'deadbeef', subject: 'Fix the widget', author: 'Avi', refs: ['origin/main'] });
  it('matches every commit on an empty needle', () => {
    expect(matchesCommit(c, '')).toBe(true);
  });
  it('matches on sha / subject / author / ref (case-insensitive needle)', () => {
    expect(matchesCommit(c, 'dead')).toBe(true);
    expect(matchesCommit(c, 'widget')).toBe(true);
    expect(matchesCommit(c, 'avi')).toBe(true);
    expect(matchesCommit(c, 'origin/main')).toBe(true);
  });
  it('returns false when the needle is nowhere in the haystack', () => {
    expect(matchesCommit(c, 'zzz-nope')).toBe(false);
  });
});
