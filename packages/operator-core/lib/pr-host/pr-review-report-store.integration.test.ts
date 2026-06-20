/**
 * pr-review-report-store.integration.test.ts — PR-2's report store against REAL
 * Postgres (testcontainer + full migrated baseline incl. migration 319).
 *
 * The unit tests (agent-reviewer.test.ts) mock the store, so the ACTUAL SQL —
 * the ON CONFLICT upsert target, the jsonb casts/round-trip, the per-head_sha
 * keying, the newest-by-reviewed_at read, and the harness_feature_prs →
 * harness_features_consolidated WI join — is only exercised here. The store
 * functions accept an injectable `sql`, so we hand them the testcontainer's
 * admin client (RLS-bypass, same as the operator's harness_admin).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  storeReviewReport,
  readLatestReviewReport,
  loadFeatureContextForPr,
} from './pr-review-report-store';
import type { PrReviewReport } from './pr-review-report-types';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

function report(over: Partial<PrReviewReport> = {}): PrReviewReport {
  return {
    summary: 'Adds the thing.',
    recommendation: 'approve',
    rationale: 'Looks correct.',
    risks: ['untested edge'],
    checksObserved: {
      checks_state: 'success',
      mergeable_state: 'mergeable',
      tests_touched: true,
      secret_suspected: false,
      diff_empty: false,
      diff_truncated: false,
      files_changed: 2,
    },
    ...over,
  };
}

describe('pr_review_reports store (integration)', () => {
  it('UPSERT is idempotent on (workspace,harness,pr_number,head_sha) + jsonb round-trips', async () => {
    const base = {
      workspaceId: 'ws1',
      harnessSlug: 'h-upsert',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      headSha: 'sha1',
      featureId: 'F-1',
      model: 'm',
      tokensIn: 10,
      tokensOut: 20,
      costUsdCents: 3,
      sql: db.adminSql,
    };
    await storeReviewReport({ ...base, report: report() });
    // Same key, different content → overwrite (not a second row, not a PK error).
    await storeReviewReport({
      ...base,
      report: report({ recommendation: 'reject', summary: 'Has a secret.', risks: ['secret'] }),
    });

    const rows = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int n FROM harness_shared.pr_review_reports
       WHERE workspace_id='ws1' AND harness_slug='h-upsert' AND pr_number=7`;
    expect(rows[0]!.n).toBe(1); // idempotent: one row per (key, head_sha)

    const r = await readLatestReviewReport({
      harnessSlug: 'h-upsert',
      prNumber: 7,
      workspaceId: 'ws1',
      sql: db.adminSql,
    });
    expect(r?.recommendation).toBe('reject'); // overwritten
    expect(r?.summary).toBe('Has a secret.');
    expect(r?.risks).toEqual(['secret']); // jsonb array round-trip
    expect(r?.checks_observed.checks_state).toBe('success'); // jsonb object round-trip
    expect(r?.head_sha).toBe('sha1');
    expect(r?.feature_id).toBe('F-1');
    expect(r?.tokens_in).toBe(10);
    expect(r?.cost_usd_cents).toBe(3);
  });

  it('a new head_sha is a separate row; readLatest returns newest by reviewed_at', async () => {
    const base = {
      workspaceId: 'ws1',
      harnessSlug: 'h-sha',
      prNumber: 9,
      prUrl: 'https://github.com/o/r/pull/9',
      featureId: null,
      model: 'm',
      tokensIn: 0,
      tokensOut: 0,
      costUsdCents: 0,
      sql: db.adminSql,
    };
    await storeReviewReport({
      ...base,
      headSha: 'old',
      report: report({ recommendation: 'reject' }),
      nowIso: '2026-01-01T00:00:00.000Z',
    });
    await storeReviewReport({
      ...base,
      headSha: 'new',
      report: report({ recommendation: 'approve' }),
      nowIso: '2026-02-01T00:00:00.000Z',
    });

    const rows = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int n FROM harness_shared.pr_review_reports
       WHERE harness_slug='h-sha' AND pr_number=9`;
    expect(rows[0]!.n).toBe(2); // per-head_sha history preserved

    const r = await readLatestReviewReport({ harnessSlug: 'h-sha', prNumber: 9, sql: db.adminSql });
    expect(r?.recommendation).toBe('approve'); // newest by reviewed_at
    expect(r?.head_sha).toBe('new');
  });

  it('the recommendation CHECK rejects an invalid value', async () => {
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.pr_review_reports
          (workspace_id, harness_slug, pr_number, pr_url, head_sha, recommendation, summary, rationale, model)
        VALUES ('w', 'h-chk', 1, 'u', 's', 'lgtm', 'x', 'y', 'm')`,
    ).rejects.toThrow();
  });

  it('readLatestReviewReport returns null when no report exists', async () => {
    const r = await readLatestReviewReport({ harnessSlug: 'h-none', prNumber: 1, sql: db.adminSql });
    expect(r).toBeNull();
  });

  it('loadFeatureContextForPr resolves the WI via harness_feature_prs + features_consolidated', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.harness_feature_prs (workspace_id, harness_slug, feature_id, pr_url, pr_state)
      VALUES ('ws1', 'h-wi', 'F-9', 'https://github.com/o/r/pull/1', 'open')`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, title, summary, status)
      VALUES ('ws1', 'h-wi', 'F-9', 'Add fn', 'sum the inputs', 'todo')`;

    const fc = await loadFeatureContextForPr({
      harnessSlug: 'h-wi',
      prUrl: 'https://github.com/o/r/pull/1',
      workspaceId: 'ws1',
      sql: db.adminSql,
    });
    expect(fc?.feature_id).toBe('F-9');
    expect(fc?.title).toBe('Add fn');
    expect(fc?.summary).toBe('sum the inputs');

    // bodyFeatureId short-circuits the pr_url lookup.
    const byBody = await loadFeatureContextForPr({
      harnessSlug: 'h-wi',
      prUrl: 'https://github.com/o/r/pull/UNKNOWN',
      bodyFeatureId: 'F-9',
      sql: db.adminSql,
    });
    expect(byBody?.feature_id).toBe('F-9');

    // No linkage → null.
    const none = await loadFeatureContextForPr({
      harnessSlug: 'h-wi',
      prUrl: 'https://github.com/o/r/pull/NOPE',
      sql: db.adminSql,
    });
    expect(none).toBeNull();
  });
});
