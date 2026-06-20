/**
 * inbound-pipeline.test.ts — the WIRED integration smoke test for the whole
 * inbound PR pipeline (ideas-pr-system-followups #3). Per-unit coverage already
 * exists (poll-daemon, agent-reviewer, auto-approve/merge, contribution-admission,
 * dogfood-roundtrip); this is the ONE test that drives the full chain in a single
 * pass so an integration break a per-unit suite misses gets caught — the exact
 * green-rig/red-binary gap the hot multi-lane tree keeps risking.
 *
 * Chain exercised (all IO mocked — no GitHub, no PG, no LLM):
 *   pollHarnessPrs (PR-1)
 *     → triggerReviewer → REAL runAgentReview (PR-2) w/ a mock LLM + in-memory report store
 *     → readReport (the stored recommendation)
 *     → decideAutoReview (the gate)
 *     → isAuthorRevoked (PR-5 contribution-admission)
 *     → tryAutoApprove / tryAutoMerge
 *
 * Asserts the cross-PR seam: trusted + green + approve → MERGES;
 * revoked / red checks / request_changes / reject → does NOT merge.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: Object.assign(() => Promise.resolve([]), { unsafe: vi.fn().mockResolvedValue([]) }) }),
  upsertRoutine: vi.fn(),
  setRoutineActive: vi.fn(),
  deleteRoutine: vi.fn(),
}));

import {
  pollHarnessPrs,
  type PollStore,
  type PollDaemonDeps,
  type ReviewerSettingsRow,
  type PollChecks,
} from './poll-daemon';
import { runAgentReview } from './agent-reviewer';
import type { StoreReviewReportArgs } from './pr-review-report-store';
import type { Pr, PrHost, PrHostResult, PrChecksState } from './types';
import { ok, err } from './types';
import type { PrReviewRecommendation } from './pr-review-report-types';

const VIEWER = { id: 1, login: 'operator' };
const TRUSTED_AUTHOR = 999;

// A diff that TOUCHES a test file + has no secrets, so the safety guard leaves an
// LLM 'approve' as approve (no `no_tests` downgrade — that's only a risk anyway).
const CLEAN_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1 +1,2 @@',
  '+export const x = 1;',
  'diff --git a/src/x.test.ts b/src/x.test.ts',
  '--- a/src/x.test.ts',
  '+++ b/src/x.test.ts',
  '@@ -0,0 +1 @@',
  "+test('x', () => { expect(x).toBe(1); });",
].join('\n');

function makePr(overrides: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number: 42 },
    state: 'open',
    title: 'Add x',
    body: null,
    head_ref: 'feat/x',
    base_ref: 'main',
    head_sha: 'a'.repeat(40),
    merge_commit_sha: null,
    author: { github_user_id: TRUSTED_AUTHOR, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'unknown',
    mergeable_state: 'mergeable',
    is_draft: false,
    url: 'https://github.com/owner/repo/pull/42',
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeHost() {
  const postReview = vi.fn(async (): Promise<PrHostResult<void>> => ok(undefined));
  const merge = vi.fn(
    async (): Promise<PrHostResult<{ merge_commit_sha: string }>> => ok({ merge_commit_sha: 'merged-sha' }),
  );
  const pr = makePr();
  const host: PrHost = {
    kind: 'github',
    openPr: vi.fn(),
    getPr: vi.fn(async () => ok(pr)),
    getPrDiff: vi.fn(async () => ok(CLEAN_DIFF)),
    postReview,
    merge,
    listOpenPrs: vi.fn(async () => ok([pr])),
  } as unknown as PrHost;
  return { host, postReview, merge };
}

function makeStore(settings?: ReviewerSettingsRow) {
  const s: ReviewerSettingsRow =
    settings ?? { pr_reviewer_role_enabled: true, auto_review: true, auto_merge: true, merge_method: 'squash' };
  const meta: Record<string, unknown> = {};
  const store: PollStore = {
    readSettings: async () => s,
    readTrust: async () => new Set([TRUSTED_AUTHOR]),
    readMeta: async () => ({ last_seen: {}, consecutive_errors: 0 }),
    patchMeta: async (_slug, patch) => void Object.assign(meta, patch),
    setNextFireAt: async () => {},
    upsertFeaturePr: async () => {},
    refreshChecks: async () => {},
  };
  return { store };
}

/** In-memory report store shared between the reviewer (writes) and readReport (reads). */
function makeReportStore() {
  const reports = new Map<string, PrReviewRecommendation>();
  const k = (slug: string, n: number) => `${slug}#${n}`;
  return {
    reports,
    store: async (args: StoreReviewReportArgs): Promise<void> => {
      reports.set(k(args.harnessSlug, args.prNumber), args.report.recommendation);
    },
    read: (slug: string, n: number) => reports.get(k(slug, n)) ?? null,
  };
}

function mockLlm(recommendation: PrReviewRecommendation) {
  return async () => ({
    text: JSON.stringify({ summary: 'adds x', recommendation, rationale: 'because', risks: [] }),
    model: 'mock-model',
    costUsd: 0,
    tokensIn: 1,
    tokensOut: 1,
  });
}

function checksOf(state: PrChecksState) {
  return async (): Promise<PrHostResult<PollChecks>> =>
    ok({
      state,
      runs: [
        {
          id: 1,
          name: 'ci',
          status: 'completed',
          conclusion: state === 'success' ? 'success' : 'failure',
          details_url: null,
          started_at: null,
          completed_at: null,
        },
      ],
    });
}

/**
 * Wire the full pipeline for one PR: the daemon's triggerReviewer runs the REAL
 * runAgentReview (mock LLM + in-memory store), and readReport returns what it
 * stored — so decideAutoReview + the revocation gate see a real recommendation.
 */
function wiredDeps(opts: {
  host: PrHost;
  store: PollStore;
  reportStore: ReturnType<typeof makeReportStore>;
  recommendation: PrReviewRecommendation;
  checks?: PrChecksState;
  authorRevoked?: boolean;
}): PollDaemonDeps {
  return {
    store: opts.store,
    createHost: async () => opts.host,
    fetchChecks: checksOf(opts.checks ?? 'success'),
    resolveViewer: async () => VIEWER,
    isAuthorRevoked: async () => opts.authorRevoked ?? false,
    triggerReviewer: async ({ installSlug, workspaceId, pr }) => {
      await runAgentReview({
        host: opts.host,
        pr,
        workspaceId,
        harnessSlug: installSlug,
        reviewerGithubId: VIEWER.id,
        diff: CLEAN_DIFF,
        runLlm: mockLlm(opts.recommendation),
        deps: {
          store: opts.reportStore.store as unknown as typeof import('./pr-review-report-store').storeReviewReport,
          audit: async () => {},
          loadFeatureContext: async () => ({ feature_id: 'F-1', title: 'Add x', summary: 'x' }),
        },
      });
    },
    readReport: async ({ installSlug, prNumber }) => {
      const rec = opts.reportStore.read(installSlug, prNumber);
      return rec ? { recommendation: rec } : null;
    },
    now: () => 1_700_000_500_000,
    random: () => 0.5,
  };
}

const ARGS = { installSlug: 'papercup', workspaceId: 'ws1', remote: 'github.com/owner/repo' };

describe('inbound pipeline (PR-1→PR-2→gate→PR-5 revocation→approve/merge)', () => {
  it('trusted + green + agent APPROVE → reviews, stores report, approves AND merges', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore();
    const reportStore = makeReportStore();
    const out = await pollHarnessPrs(ARGS, wiredDeps({ host, store, reportStore, recommendation: 'approve' }));

    expect(out.triggered).toEqual([42]);
    expect(reportStore.read('papercup', 42)).toBe('approve'); // PR-2 ran end-to-end
    expect(out.approved).toEqual([42]);
    expect(out.merged).toEqual([42]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('agent REQUEST_CHANGES → report vetoes the auto path (no approve, no merge)', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore();
    const reportStore = makeReportStore();
    const out = await pollHarnessPrs(
      ARGS,
      wiredDeps({ host, store, reportStore, recommendation: 'request_changes' }),
    );
    expect(reportStore.read('papercup', 42)).toBe('request_changes');
    expect(out.vetoed).toEqual([42]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('agent REJECT → vetoes (no merge)', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const reportStore = makeReportStore();
    const out = await pollHarnessPrs(ARGS, wiredDeps({ host, store, reportStore, recommendation: 'reject' }));
    expect(reportStore.read('papercup', 42)).toBe('reject');
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('PR-5: a REVOKED author is refused the whole auto path even with a green APPROVE report', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore();
    const reportStore = makeReportStore();
    const out = await pollHarnessPrs(
      ARGS,
      wiredDeps({ host, store, reportStore, recommendation: 'approve', authorRevoked: true }),
    );
    expect(out.revoked).toEqual([42]);
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('RED checks → the safety guard downgrades the report AND decideAutoReview blocks merge (no merge)', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const reportStore = makeReportStore();
    // LLM says approve, but checks are failing → assembleReport floors to request_changes.
    const out = await pollHarnessPrs(
      ARGS,
      wiredDeps({ host, store, reportStore, recommendation: 'approve', checks: 'failure' }),
    );
    expect(reportStore.read('papercup', 42)).toBe('request_changes'); // guard raised severity
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });
});
