import { describe, it, expect, vi } from 'vitest';
import type { Pr, PrHost, PrHostResult } from './types';
import {
  reviewPr,
  runAgentReview,
  buildReviewPrompt,
  loadRepoConventions,
  type LlmRunner,
  type LlmRunResult,
} from './agent-reviewer';
import type {
  FeatureContext,
  loadFeatureContextForPr,
  storeReviewReport,
  writeAgentReviewAudit,
} from './pr-review-report-store';

function makePr(overrides: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number: 42 },
    state: 'open',
    title: 'Fix add',
    body: 'Closes FEAT-7',
    head_ref: 'fix/add',
    base_ref: 'main',
    head_sha: 'deadbeef',
    merge_commit_sha: null,
    author: { github_user_id: 999, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'success',
    mergeable_state: 'mergeable',
    is_draft: false,
    url: 'https://github.com/owner/repo/pull/42',
    updated_at: 1716508800000,
    ...overrides,
  };
}

const CLEAN_DIFF = [
  'diff --git a/src/add.ts b/src/add.ts',
  '--- a/src/add.ts',
  '+++ b/src/add.ts',
  '@@ -1 +1 @@',
  '-export const add = (a, b) => a - b;',
  '+export const add = (a, b) => a + b;',
  'diff --git a/src/add.test.ts b/src/add.test.ts',
  '+++ b/src/add.test.ts',
  '@@ -0,0 +1 @@',
  "+test('adds', () => expect(add(1,2)).toBe(3));",
].join('\n');

/** A PrHost whose getPrDiff returns `diff`; postReview/merge are spies we
 *  assert are NEVER called (the reviewer must not act on the host). */
function makeHost(diff: string | { err: true }): PrHost {
  const getPrDiff = vi.fn(
    async (): Promise<PrHostResult<string>> =>
      typeof diff === 'string'
        ? { ok: true, data: diff }
        : { ok: false, error: { kind: 'not_found', message: '404' } },
  );
  return {
    kind: 'github',
    openPr: vi.fn(),
    getPr: vi.fn(),
    getPrDiff,
    postReview: vi.fn(),
    merge: vi.fn(),
    listOpenPrs: vi.fn(),
  };
}

/** A host whose getRepoFile resolves only the paths present in `files`. */
function makeHostWithFiles(files: Record<string, string>): PrHost {
  const host = makeHost(CLEAN_DIFF);
  host.getRepoFile = vi.fn(async ({ path }: { path: string }): Promise<PrHostResult<string>> =>
    path in files
      ? { ok: true, data: files[path]! }
      : { ok: false, error: { kind: 'not_found', message: '404' } },
  );
  return host;
}

function llmReturning(json: object | string): LlmRunner {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  return vi.fn(
    async (): Promise<LlmRunResult> => ({
      text,
      model: 'test-model',
      costUsd: 0.0123,
      tokensIn: 100,
      tokensOut: 50,
    }),
  );
}

const approveJson = {
  summary: 'Fixes add to use +.',
  recommendation: 'approve',
  rationale: 'Correct fix with a test.',
  risks: [],
};

function assertNeverPosted(host: PrHost): void {
  expect(vi.mocked(host.postReview)).not.toHaveBeenCalled();
  expect(vi.mocked(host.merge)).not.toHaveBeenCalled();
}

describe('reviewPr', () => {
  it('clean PR + LLM approve → approve, with provenance', async () => {
    const host = makeHost(CLEAN_DIFF);
    const res = await reviewPr({ host, pr: makePr(), runLlm: llmReturning(approveJson), model: 'm' });
    expect(res.ok).toBe(true);
    expect(res.report.recommendation).toBe('approve');
    expect(res.report.checksObserved.tests_touched).toBe(true);
    expect(res.provenance.tokens_in).toBe(100);
    expect(res.provenance.cost_usd_cents).toBe(1); // 0.0123 → 1 cent
    expect(res.provenance.head_sha).toBe('deadbeef');
    assertNeverPosted(host);
  });

  it('TEETH: failing checks → request_changes even when the LLM says approve', async () => {
    const host = makeHost(CLEAN_DIFF);
    const res = await reviewPr({
      host,
      pr: makePr({ checks_state: 'failure' }),
      runLlm: llmReturning(approveJson),
      model: 'm',
    });
    expect(res.ok).toBe(true); // the model DID produce a parseable report
    expect(res.report.recommendation).toBe('request_changes');
    assertNeverPosted(host);
  });

  it('TEETH: a planted secret → reject even when the LLM says approve', async () => {
    const secretDiff = '+++ b/c\n@@\n+const k = "AKIAIOSFODNN7EXAMPLE";';
    const host = makeHost(secretDiff);
    const res = await reviewPr({ host, pr: makePr(), runLlm: llmReturning(approveJson), model: 'm' });
    expect(res.report.recommendation).toBe('reject');
    assertNeverPosted(host);
  });

  it('LLM unavailable → ok:false, safe request_changes fallback', async () => {
    const host = makeHost(CLEAN_DIFF);
    const runLlm: LlmRunner = vi.fn(async () => null);
    const res = await reviewPr({ host, pr: makePr(), runLlm, model: 'm' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('llm_unavailable');
    expect(res.report.recommendation).toBe('request_changes');
    assertNeverPosted(host);
  });

  it('unparseable LLM output → ok:false, fallback', async () => {
    const host = makeHost(CLEAN_DIFF);
    const res = await reviewPr({ host, pr: makePr(), runLlm: llmReturning('not json at all'), model: 'm' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unparseable_llm_output');
    expect(res.report.recommendation).toBe('request_changes');
  });

  it('diff fetch failure → empty-diff path, LLM not called, request_changes', async () => {
    const host = makeHost({ err: true });
    const runLlm = llmReturning(approveJson);
    const res = await reviewPr({ host, pr: makePr(), runLlm, model: 'm' });
    expect(res.report.recommendation).toBe('request_changes');
    expect(res.report.checksObserved.diff_empty).toBe(true);
    expect(res.error).toBe('diff_fetch_failed:not_found');
    expect(vi.mocked(runLlm)).not.toHaveBeenCalled();
    assertNeverPosted(host);
  });

  it('uses a pre-fetched diff without calling host.getPrDiff', async () => {
    const host = makeHost(CLEAN_DIFF);
    await reviewPr({ host, pr: makePr(), diff: CLEAN_DIFF, runLlm: llmReturning(approveJson), model: 'm' });
    expect(vi.mocked(host.getPrDiff)).not.toHaveBeenCalled();
  });
});

describe('buildReviewPrompt', () => {
  it('includes PR meta, WI context, conventions, and the diff', () => {
    const fc: FeatureContext = { feature_id: 'FEAT-7', title: 'Add fn', summary: 'sum the inputs' };
    const prompt = buildReviewPrompt({
      pr: makePr(),
      diff: CLEAN_DIFF,
      featureContext: fc,
      conventions: 'Always add a test.',
    });
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('FEAT-7');
    expect(prompt).toContain('Always add a test.');
    expect(prompt).toContain('export const add');
  });
  it('notes when there is no WI link', () => {
    const prompt = buildReviewPrompt({ pr: makePr(), diff: CLEAN_DIFF, featureContext: null });
    expect(prompt).toMatch(/not linked to a tracked work-item/);
  });
});

describe('loadRepoConventions', () => {
  it('returns the highest-priority present candidate', async () => {
    const host = makeHostWithFiles({
      'AGENTS.md': 'agents conventions',
      'CLAUDE.md': 'claude conventions',
    });
    const conv = await loadRepoConventions({ host, remote: 'github.com/o/r' });
    expect(conv).toBe('agents conventions'); // AGENTS.md outranks CLAUDE.md
  });
  it('prefers CONTRIBUTING.md over AGENTS.md', async () => {
    const host = makeHostWithFiles({
      'CONTRIBUTING.md': 'contrib',
      'AGENTS.md': 'agents',
    });
    expect(await loadRepoConventions({ host, remote: 'github.com/o/r' })).toBe('contrib');
  });
  it('returns null when no candidate exists', async () => {
    const host = makeHostWithFiles({ 'README.md': 'x' });
    expect(await loadRepoConventions({ host, remote: 'github.com/o/r' })).toBeNull();
  });
  it('returns null when the host cannot fetch files', async () => {
    const host = makeHost(CLEAN_DIFF); // no getRepoFile
    expect(await loadRepoConventions({ host, remote: 'github.com/o/r' })).toBeNull();
  });
  it('truncates an oversized conventions doc', async () => {
    const host = makeHostWithFiles({ 'CONTRIBUTING.md': 'x'.repeat(50) });
    const conv = await loadRepoConventions({ host, remote: 'github.com/o/r', maxChars: 10 });
    expect(conv).toMatch(/conventions truncated/);
    expect(conv!.length).toBeLessThan(50);
  });
});

describe('runAgentReview', () => {
  function deps() {
    return {
      loadFeatureContext: vi.fn<typeof loadFeatureContextForPr>(async () => ({
        feature_id: 'FEAT-7',
        title: 'Add fn',
        summary: 's',
      })),
      loadConventions: vi.fn<typeof loadRepoConventions>(async () => null),
      store: vi.fn<typeof storeReviewReport>(async () => undefined),
      audit: vi.fn<typeof writeAgentReviewAudit>(async () => undefined),
    };
  }

  it('reviews → stores → audits (agent_review) and links the WI', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    const res = await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });

    expect(res.ok).toBe(true);
    expect(res.recommendation).toBe('approve');
    expect(res.featureId).toBe('FEAT-7');

    // WI resolution happened against the PR url.
    expect(d.loadFeatureContext).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'papercup', prUrl: makePr().url }),
    );
    // Stored with the resolved WI + provenance.
    expect(d.store).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        harnessSlug: 'papercup',
        prNumber: 42,
        featureId: 'FEAT-7',
        headSha: 'deadbeef',
        model: 'test-model', // provenance records the model the runner reported
      }),
    );
    // Audited as a successful agent review, with model+sha in detail.
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_review', reviewerGithubId: 7, prNumber: 42 }),
    );
    const auditArg = d.audit.mock.calls[0]?.[0];
    expect(auditArg).toBeDefined();
    const detail = JSON.parse(auditArg!.detail);
    expect(detail.recommendation).toBe('approve');
    expect(detail.head_sha).toBe('deadbeef');
    expect(detail.feature_id).toBe('FEAT-7');

    assertNeverPosted(host);
  });

  it('records agent_review_error when the model fails', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    const res = await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      runLlm: vi.fn(async () => null),
      model: 'm',
      deps: d,
    });
    expect(res.ok).toBe(false);
    expect(res.recommendation).toBe('request_changes');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_review_error' }));
    // A report is STILL stored (honest "couldn't review" state), never approved.
    expect(d.store).toHaveBeenCalled();
  });

  it('skips the WI lookup when context is pre-resolved', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      featureContext: { feature_id: 'FEAT-9', title: null, summary: null },
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });
    expect(d.loadFeatureContext).not.toHaveBeenCalled();
    expect(d.store).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'FEAT-9' }));
  });

  it('proceeds with null feature_id when no WI link exists', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    d.loadFeatureContext.mockResolvedValue(null);
    const res = await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });
    expect(res.featureId).toBeNull();
    expect(d.store).toHaveBeenCalledWith(expect.objectContaining({ featureId: null }));
  });

  it('loads repo conventions when the caller did not supply them', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    d.loadConventions.mockResolvedValue('be tidy');
    await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });
    expect(d.loadConventions).toHaveBeenCalledWith(
      expect.objectContaining({ remote: 'github.com/owner/repo', ref: 'main' }),
    );
  });

  it('does not load conventions when the caller supplied them', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      conventions: 'caller-provided',
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });
    expect(d.loadConventions).not.toHaveBeenCalled();
  });

  it('still returns the recommendation when the store fails', async () => {
    const host = makeHost(CLEAN_DIFF);
    const d = deps();
    d.store.mockRejectedValue(new Error('pg down'));
    const res = await runAgentReview({
      host,
      pr: makePr(),
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      reviewerGithubId: 7,
      runLlm: llmReturning(approveJson),
      model: 'm',
      deps: d,
    });
    expect(res.recommendation).toBe('approve');
    expect(res.ok).toBe(false); // store failure surfaces in ok
    expect(d.audit).toHaveBeenCalled();
  });
});
