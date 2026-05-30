/**
 * completion-ref-stamp.test.ts — unit tests for stampCompletionRefOnMerge
 * (the P-016 completion_ref writer wired into the PR poll daemon).
 *
 * No live PG: `sql` is a fake tagged-template that records its bound values
 * and returns whatever rows the test supplies (so we can simulate "stamped"
 * vs "already stamped" / idempotent).
 */

import { describe, it, expect } from 'vitest';
import { stampCompletionRefOnMerge } from './poll-daemon';
import type { SqlClient } from '../harness/completion-ref-verifier';
import type { HarnessFeaturePrRow } from './harness-feature-pr-row-types';
import type { LivePr } from './types';

function fakeSql(returnRows: unknown[]) {
  const calls: Array<{ values: unknown[] }> = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ values });
    return Promise.resolve(returnRows);
  }) as unknown as SqlClient;
  return { sql, calls };
}

const PR = {
  feature_id: 'F-1',
  owner: 'Papercusp',
  repo: 'papercup',
  pr_number: 42,
} as unknown as HarnessFeaturePrRow;

const SHA = 'a'.repeat(40);

const MERGED: LivePr = {
  number: 42,
  state: 'merged',
  base_ref: 'main',
  head_ref: 'user/1',
  merge_commit_sha: SHA,
  html_url: 'https://github.com/Papercusp/papercup/pull/42',
  checks_status: 'passing',
  review_decision: 'approved',
  mergeable: true,
};

describe('stampCompletionRefOnMerge', () => {
  it('stamps a valid completion_ref when the PR is merged', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    const did = await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: MERGED });
    expect(did).toBe(true);
    expect(calls).toHaveLength(1);
    // The bound values include the JSON ref, the harness slug, and feature id.
    const values = calls[0]!.values;
    expect(values).toContain('papercup');
    expect(values).toContain('F-1');
    const jsonArg = values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    const ref = JSON.parse(jsonArg);
    expect(ref.commit_sha).toBe(SHA);
    expect(ref.branch).toBe('main');
    expect(ref.pr_url).toBe('https://github.com/Papercusp/papercup/pull/42');
    expect(ref.pr_number).toBe(42);
    expect(ref.schema_version).toBe(1);
  });

  it('derives the remote from owner/repo when no remoteUrl is supplied', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: MERGED });
    const jsonArg = calls[0]!.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(JSON.parse(jsonArg).remote).toBe('https://github.com/Papercusp/papercup.git');
  });

  it('prefers an explicit remoteUrl', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    await stampCompletionRefOnMerge({
      sql,
      harnessSlug: 'papercup',
      pr: PR,
      live: MERGED,
      remoteUrl: 'git@github.com:Papercusp/papercup.git',
    });
    const jsonArg = calls[0]!.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(JSON.parse(jsonArg).remote).toBe('git@github.com:Papercusp/papercup.git');
  });

  it('is idempotent — returns false when the row already had a completion_ref (0 rows updated)', async () => {
    const { sql } = fakeSql([]); // WHERE completion_ref IS NULL matched nothing
    const did = await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: MERGED });
    expect(did).toBe(false);
  });

  it('does nothing for a non-merged PR', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    const open: LivePr = { ...MERGED, state: 'open', merge_commit_sha: null };
    const did = await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: open });
    expect(did).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing when merged but the merge_commit_sha is missing', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    const noSha: LivePr = { ...MERGED, merge_commit_sha: null };
    const did = await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: noSha });
    expect(did).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('skips (no throw, no write) when the merge SHA is malformed', async () => {
    const { sql, calls } = fakeSql([{ feature_id: 'F-1' }]);
    const badSha: LivePr = { ...MERGED, merge_commit_sha: 'not-a-sha' };
    const did = await stampCompletionRefOnMerge({ sql, harnessSlug: 'papercup', pr: PR, live: badSha });
    expect(did).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
