/**
 * Phase 2 (D-001) — coverage for the completion_ref writer: PR→feature
 * resolution (body-supplied wins; harness_feature_prs fallback; null when
 * unresolved) and the stamp (skip on no-feature/empty/invalid SHA; on success
 * UPDATE with the lowercased SHA + status='shipped' + fresh updated_ts, scoped
 * by (harness_slug, feature_id), idempotent via completion_ref IS NULL). `sql`
 * is mocked; buildCompletionRef is the real validator.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveMergedPrFeatureId, stampCompletionRefOnMerge } from './completion-ref-writer';

const makeSql = () => vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const SHA40 = 'A'.repeat(40); // uppercase → must be lowercased before buildCompletionRef
const PR_URL = 'https://github.com/o/r/pull/5';

describe('resolveMergedPrFeatureId', () => {
  it('prefers a body-supplied feature_id (no DB hit)', async () => {
    const sql = makeSql();
    expect(
      await resolveMergedPrFeatureId({ harnessSlug: 'h', prUrl: PR_URL, bodyFeatureId: 'F-1', sql: sql as never }),
    ).toBe('F-1');
    expect(sql).not.toHaveBeenCalled();
  });

  it('falls back to harness_feature_prs by pr_url', async () => {
    const sql = makeSql();
    sql.mockResolvedValueOnce([{ feature_id: 'F-9' }]);
    expect(await resolveMergedPrFeatureId({ harnessSlug: 'h', prUrl: PR_URL, sql: sql as never })).toBe('F-9');
    const args = sql.mock.calls[0] as unknown as unknown[];
    expect(args).toContain('h');
    expect(args).toContain(PR_URL);
  });

  it('returns null when the fallback finds nothing', async () => {
    const sql = makeSql();
    sql.mockResolvedValueOnce([]);
    expect(await resolveMergedPrFeatureId({ harnessSlug: 'h', prUrl: PR_URL, sql: sql as never })).toBeNull();
  });

  it('returns null (no DB hit) when neither body nor pr_url is available', async () => {
    const sql = makeSql();
    expect(await resolveMergedPrFeatureId({ harnessSlug: 'h', prUrl: '', sql: sql as never })).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('stampCompletionRefOnMerge', () => {
  const base = { harnessSlug: 'h', remote: 'github.com/o/r', branch: 'main', prUrl: PR_URL, prNumber: 5 };

  it('skips (no DB) when feature_id is null', async () => {
    const sql = makeSql();
    expect(await stampCompletionRefOnMerge({ ...base, featureId: null, mergeCommitSha: SHA40, sql: sql as never })).toEqual({
      stamped: false,
      reason: 'no_feature_id',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips on an empty merge SHA (github.ts ?? "" guard)', async () => {
    const sql = makeSql();
    expect(await stampCompletionRefOnMerge({ ...base, featureId: 'F-1', mergeCommitSha: '', sql: sql as never })).toEqual({
      stamped: false,
      reason: 'empty_sha',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips on an invalid SHA (buildCompletionRef rejects)', async () => {
    const sql = makeSql();
    const r = await stampCompletionRefOnMerge({ ...base, featureId: 'F-1', mergeCommitSha: 'not-a-sha', sql: sql as never });
    expect(r).toEqual({ stamped: false, reason: 'invalid_ref' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('stamps: lowercased SHA + status=shipped + fresh updated_ts, scoped by (slug, feature)', async () => {
    const sql = makeSql();
    const r = await stampCompletionRefOnMerge({
      ...base,
      featureId: 'F-1',
      mergeCommitSha: SHA40,
      nowMs: 1_700_000_000_000,
      sql: sql as never,
    });
    expect(r).toEqual({ stamped: true, feature_id: 'F-1' });
    const args = sql.mock.calls[0] as unknown as unknown[];
    // UPDATE … SET completion_ref=${json}, … updated_ts=${now} WHERE harness_slug=${slug} AND feature_id=${fid}
    const ref = JSON.parse(args[1] as string);
    expect(ref.commit_sha).toBe('a'.repeat(40)); // lowercased
    expect(ref.remote).toBe('github.com/o/r');
    expect(ref.branch).toBe('main');
    expect(ref.pr_number).toBe(5);
    expect(args).toContain(1_700_000_000_000); // updated_ts
    expect(args).toContain('h'); // harness_slug
    expect(args).toContain('F-1'); // feature_id
  });
});
