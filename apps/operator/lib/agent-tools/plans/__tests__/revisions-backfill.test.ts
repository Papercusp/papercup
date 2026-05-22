/**
 * Unit coverage for the git-history backfill's pure mapper
 * (plan-agent-launch-2026-05-21, P-005).
 *
 * `commitToBackfillInput` is the one DB-free, git-free piece of the
 * backfill — the commit→revision-input mapping, including the
 * empty-subject and unparseable-date fallbacks. The full backfill
 * flow (`backfillPlanRevisionsForSlug`) needs git + the lock + the
 * `harness_shared` schema and is verified live in P-027.
 */

import { describe, expect, it } from 'vitest';
import { commitToBackfillInput } from '../revisions-backfill';
import { hashPlanContent } from '../content-hash';
import type { GitCommit } from '../git-history';

function commit(over: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: 'abc1234',
    author: 'Avi',
    date: '2026-05-20T12:00:00Z',
    subject: 'plans P-001: ensure the revision table',
    ...over,
  };
}

describe('commitToBackfillInput', () => {
  it('maps a commit + content into a backfill revision input', () => {
    const content = '# Plan\n\nbody text';
    expect(commitToBackfillInput(commit(), content)).toEqual({
      contentHash: hashPlanContent(content),
      content,
      rationale: 'plans P-001: ensure the revision table',
      authorId: 'Avi',
      createdAt: Date.parse('2026-05-20T12:00:00Z'),
    });
  });

  it('maps a blank commit subject to a null rationale', () => {
    expect(commitToBackfillInput(commit({ subject: '   ' }), 'x').rationale).toBeNull();
    expect(commitToBackfillInput(commit({ subject: '' }), 'x').rationale).toBeNull();
  });

  it('falls back to "now" for an unparseable commit date', () => {
    const before = Date.now();
    const r = commitToBackfillInput(commit({ date: 'not-a-date' }), 'x');
    expect(r.createdAt).toBeGreaterThanOrEqual(before);
  });
});
