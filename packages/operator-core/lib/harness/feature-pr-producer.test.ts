/**
 * feature-pr-producer.test.ts — the WI↔PR producer for harness_feature_prs
 * (PLAN-pr-system-completion-dogfood PR-4 (b)).
 *
 * The teeth: a fork→PR open writes the row; the merge-time
 * `resolveMergedPrFeatureId` (completion-ref-writer) resolves the feature FROM
 * that row — and resolves NOTHING when the producer is neutered (the pre-PR-4
 * "empty fallback" state). A shared in-memory `harness_feature_prs` (a tagged-
 * template `sql` stub) lets the producer and the resolver round-trip with no real
 * PG.
 */
import { describe, expect, it } from 'vitest';
import { upsertFeaturePrOnOpen, markFeaturePrState } from './feature-pr-producer';
import { resolveMergedPrFeatureId } from './completion-ref-writer';

/**
 * Minimal in-memory stand-in for the `harness_feature_prs` table behind a
 * tagged-template `sql`. Interprets exactly the three statement shapes PR-4 uses:
 * the producer's UPSERT, its state UPDATE, and the resolver's SELECT — so the
 * producer→resolver round-trip is a real round-trip, not two mocks agreeing.
 */
function makePrTable() {
  const rows: Array<Record<string, unknown>> = [];
  const sql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join(' ');
    if (/INSERT INTO\s+harness_shared\.harness_feature_prs/i.test(text)) {
      const [ws, harnessSlug, featureId, prUrl, openedTs, updatedTs, author] = vals as [
        string, string, string, string, number, number, number | null,
      ];
      const existing = rows.find(
        (r) => r.workspace_id === ws && r.harness_slug === harnessSlug && r.feature_id === featureId,
      );
      if (existing) {
        // ON CONFLICT DO UPDATE: pr_url/pr_state/updated_ts refreshed; opened_ts
        // preserved; author COALESCE'd (a null open can't wipe a recorded author).
        existing.pr_url = prUrl;
        existing.pr_state = 'open';
        existing.updated_ts = updatedTs;
        if (author != null) existing.author_github_user_id = author;
      } else {
        rows.push({
          workspace_id: ws,
          harness_slug: harnessSlug,
          feature_id: featureId,
          pr_url: prUrl,
          pr_state: 'open',
          opened_ts: openedTs,
          updated_ts: updatedTs,
          author_github_user_id: author ?? null,
        });
      }
      return [];
    }
    if (/UPDATE\s+harness_shared\.harness_feature_prs/i.test(text)) {
      const [prState, updatedTs, harnessSlug, prUrl] = vals as [string, number, string, string];
      for (const r of rows) {
        if (r.harness_slug === harnessSlug && r.pr_url === prUrl) {
          r.pr_state = prState;
          r.updated_ts = updatedTs;
        }
      }
      return [];
    }
    if (/SELECT\s+feature_id\s+FROM\s+harness_shared\.harness_feature_prs/i.test(text)) {
      const [harnessSlug, prUrl] = vals as [string, string];
      const r = rows.find((x) => x.harness_slug === harnessSlug && x.pr_url === prUrl);
      return r ? [{ feature_id: r.feature_id }] : [];
    }
    return [];
  };
  return { sql, rows };
}

const PR_URL = 'https://github.com/papercupai/papercup/pull/7';

describe('upsertFeaturePrOnOpen', () => {
  it('writes the WI→PR row with the operator as author, state open', async () => {
    const { sql, rows } = makePrTable();
    await upsertFeaturePrOnOpen({
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      featureId: 'F-001',
      prUrl: PR_URL,
      authorGithubUserId: 4242,
      nowMs: 1_700_000_000_000,
      sql: sql as never,
    });
    expect(rows).toEqual([
      {
        workspace_id: 'ws1',
        harness_slug: 'papercup',
        feature_id: 'F-001',
        pr_url: PR_URL,
        pr_state: 'open',
        opened_ts: 1_700_000_000_000,
        updated_ts: 1_700_000_000_000,
        author_github_user_id: 4242,
      },
    ]);
  });

  it('defaults workspace_id to "" and author to null when unresolved', async () => {
    const { sql, rows } = makePrTable();
    await upsertFeaturePrOnOpen({ harnessSlug: 'h', featureId: 'F-1', prUrl: PR_URL, sql: sql as never });
    expect(rows[0].workspace_id).toBe('');
    expect(rows[0].author_github_user_id).toBeNull();
  });

  it('is idempotent per feature (PK) — re-open updates pr_url, preserves opened_ts', async () => {
    const { sql, rows } = makePrTable();
    await upsertFeaturePrOnOpen({
      harnessSlug: 'h', featureId: 'F-1', prUrl: PR_URL, authorGithubUserId: 1, nowMs: 1000, sql: sql as never,
    });
    await upsertFeaturePrOnOpen({
      harnessSlug: 'h', featureId: 'F-1', prUrl: PR_URL + '-v2', nowMs: 2000, sql: sql as never,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_url).toBe(PR_URL + '-v2');
    expect(rows[0].opened_ts).toBe(1000); // preserved on conflict
    expect(rows[0].updated_ts).toBe(2000);
    // COALESCE: the second open carried no author → the first author survives.
    expect(rows[0].author_github_user_id).toBe(1);
  });
});

describe('markFeaturePrState', () => {
  it('advances a tracked PR to merged by (harness_slug, pr_url)', async () => {
    const { sql, rows } = makePrTable();
    await upsertFeaturePrOnOpen({ harnessSlug: 'h', featureId: 'F-1', prUrl: PR_URL, nowMs: 1000, sql: sql as never });
    await markFeaturePrState({ harnessSlug: 'h', prUrl: PR_URL, prState: 'merged', nowMs: 5000, sql: sql as never });
    expect(rows[0].pr_state).toBe('merged');
    expect(rows[0].updated_ts).toBe(5000);
  });
});

describe('producer ↔ resolveMergedPrFeatureId round-trip (the teeth)', () => {
  it('the merge resolves the feature FROM the producer row — and NULL when the producer is neutered', async () => {
    // WITH the producer: the row exists → the merge stamp resolves the feature.
    const live = makePrTable();
    await upsertFeaturePrOnOpen({
      harnessSlug: 'papercup', featureId: 'F-001', prUrl: PR_URL, authorGithubUserId: 9, sql: live.sql as never,
    });
    expect(
      await resolveMergedPrFeatureId({ harnessSlug: 'papercup', prUrl: PR_URL, sql: live.sql as never }),
    ).toBe('F-001');

    // NEUTERED producer (no upsert): the fallback is empty → the merge can't
    // resolve the feature = the pre-PR-4 RED state.
    const neutered = makePrTable();
    expect(
      await resolveMergedPrFeatureId({ harnessSlug: 'papercup', prUrl: PR_URL, sql: neutered.sql as never }),
    ).toBeNull();
  });
});
