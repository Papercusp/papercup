import { describe, it, expect } from 'vitest';
import type { Pr } from './types';
import {
  PR_REVIEW_RECOMMENDATIONS,
  extractJsonObject,
  parseRawLlmReview,
  scanDiffForSecrets,
  diffChangedPaths,
  diffTouchesTests,
  isDiffEmpty,
  computeReviewSignals,
  applySafetyGuard,
  assembleReport,
  reportGatesAutoApprove,
  isStoredPrReviewReport,
  GUARD_RISK,
  type RawLlmReview,
  type ReviewSignals,
} from './pr-review-report-types';

function makePr(overrides: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number: 42 },
    state: 'open',
    title: 'Fix thing',
    body: null,
    head_ref: 'fix/thing',
    base_ref: 'main',
    head_sha: 'abc123',
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
  'index 111..222 100644',
  '--- a/src/add.ts',
  '+++ b/src/add.ts',
  '@@ -1,1 +1,1 @@',
  '-export const add = (a, b) => a - b;',
  '+export const add = (a, b) => a + b;',
  'diff --git a/src/add.test.ts b/src/add.test.ts',
  '--- a/src/add.test.ts',
  '+++ b/src/add.test.ts',
  '@@ -0,0 +1,1 @@',
  "+test('adds', () => expect(add(1,2)).toBe(3));",
].join('\n');

const cleanRaw: RawLlmReview = {
  summary: 'Fixes the add function to add instead of subtract.',
  recommendation: 'approve',
  rationale: 'Correct one-line fix with a test.',
  risks: [],
};

function signalsFrom(pr: Pr, diff: string): ReviewSignals {
  return computeReviewSignals({ pr, diff });
}

describe('PR_REVIEW_RECOMMENDATIONS', () => {
  it('is exactly the three values', () => {
    expect([...PR_REVIEW_RECOMMENDATIONS]).toEqual(['approve', 'request_changes', 'reject']);
  });
});

describe('extractJsonObject', () => {
  it('extracts a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it('extracts from prose + fence', () => {
    const txt = 'Here is the report:\n```json\n{"a": {"b": 2}}\n```\nThanks.';
    expect(extractJsonObject(txt)).toBe('{"a": {"b": 2}}');
  });
  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"s": "a } b"}')).toBe('{"s": "a } b"}');
  });
  it('returns null when no object present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('parseRawLlmReview', () => {
  it('parses a valid report', () => {
    const r = parseRawLlmReview(
      'sure:\n{"summary":"s","recommendation":"approve","rationale":"r","risks":["x"]}',
    );
    expect(r).toEqual({ summary: 's', recommendation: 'approve', rationale: 'r', risks: ['x'] });
  });
  it('rejects an invalid recommendation', () => {
    expect(
      parseRawLlmReview('{"summary":"s","recommendation":"lgtm","rationale":"r","risks":[]}'),
    ).toBeNull();
  });
  it('rejects empty summary / rationale', () => {
    expect(
      parseRawLlmReview('{"summary":"","recommendation":"approve","rationale":"r","risks":[]}'),
    ).toBeNull();
    expect(
      parseRawLlmReview('{"summary":"s","recommendation":"approve","rationale":"  ","risks":[]}'),
    ).toBeNull();
  });
  it('defaults missing risks to [] and drops non-string risks', () => {
    const r = parseRawLlmReview(
      '{"summary":"s","recommendation":"reject","rationale":"r","risks":["ok",3,null,"two"]}',
    );
    expect(r?.risks).toEqual(['ok', 'two']);
    const r2 = parseRawLlmReview('{"summary":"s","recommendation":"reject","rationale":"r"}');
    expect(r2?.risks).toEqual([]);
  });
  it('returns null on malformed JSON', () => {
    expect(parseRawLlmReview('{not json')).toBeNull();
  });
});

describe('diff scanners', () => {
  it('scanDiffForSecrets flags an AWS key on an added line', () => {
    const diff = 'diff --git a/c b/c\n+++ b/c\n@@\n+const k = "AKIAIOSFODNN7EXAMPLE";';
    expect(scanDiffForSecrets(diff)).toBe(true);
  });
  it('scanDiffForSecrets flags a private key block', () => {
    const diff = '+++ b/key.pem\n+-----BEGIN RSA PRIVATE KEY-----';
    expect(scanDiffForSecrets(diff)).toBe(true);
  });
  it('scanDiffForSecrets flags a credential assignment', () => {
    const diff = '+++ b/c\n+  password = "hunter2hunter2"';
    expect(scanDiffForSecrets(diff)).toBe(true);
  });
  it('scanDiffForSecrets ignores secrets on REMOVED lines', () => {
    const diff = 'diff --git a/c b/c\n--- a/c\n-const k = "AKIAIOSFODNN7EXAMPLE";';
    expect(scanDiffForSecrets(diff)).toBe(false);
  });
  it('scanDiffForSecrets does not flag the +++ header path', () => {
    expect(scanDiffForSecrets('+++ b/secret_AKIAIOSFODNN7EXAMPLE.ts')).toBe(false);
  });
  it('scanDiffForSecrets is false for a clean diff', () => {
    expect(scanDiffForSecrets(CLEAN_DIFF)).toBe(false);
  });
  it('diffChangedPaths lists both sides', () => {
    expect(diffChangedPaths(CLEAN_DIFF)).toContain('src/add.ts');
    expect(diffChangedPaths(CLEAN_DIFF)).toContain('src/add.test.ts');
  });
  it('diffTouchesTests detects a test file', () => {
    expect(diffTouchesTests(CLEAN_DIFF)).toBe(true);
    const noTest = 'diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@\n+const x = 1;';
    expect(diffTouchesTests(noTest)).toBe(false);
  });
  it('isDiffEmpty true for empty/whitespace/prose, false for a real diff', () => {
    expect(isDiffEmpty('')).toBe(true);
    expect(isDiffEmpty('   \n  ')).toBe(true);
    expect(isDiffEmpty('just some words')).toBe(true);
    expect(isDiffEmpty(CLEAN_DIFF)).toBe(false);
  });
});

describe('computeReviewSignals', () => {
  it('carries CI/mergeable state + diff-derived facts', () => {
    const s = signalsFrom(makePr({ checks_state: 'pending', mergeable_state: 'unknown' }), CLEAN_DIFF);
    expect(s.checks_state).toBe('pending');
    expect(s.mergeable_state).toBe('unknown');
    expect(s.tests_touched).toBe(true);
    expect(s.secret_suspected).toBe(false);
    expect(s.diff_empty).toBe(false);
    expect(s.files_changed).toBeGreaterThanOrEqual(2);
  });
  it('zeroes diff-derived facts for an empty diff', () => {
    const s = signalsFrom(makePr(), '');
    expect(s.diff_empty).toBe(true);
    expect(s.tests_touched).toBe(false);
    expect(s.secret_suspected).toBe(false);
    expect(s.diff_truncated).toBe(false);
    expect(s.files_changed).toBe(0);
  });

  it('flags diff_truncated only when the diff exceeds maxChars', () => {
    const pr = makePr({ checks_state: 'success' });
    expect(computeReviewSignals({ pr, diff: CLEAN_DIFF }).diff_truncated).toBe(false); // no maxChars
    expect(computeReviewSignals({ pr, diff: CLEAN_DIFF, maxChars: 10 }).diff_truncated).toBe(true);
    expect(computeReviewSignals({ pr, diff: CLEAN_DIFF, maxChars: 100000 }).diff_truncated).toBe(false);
    // An empty diff is never "truncated".
    expect(computeReviewSignals({ pr, diff: '', maxChars: 1 }).diff_truncated).toBe(false);
  });
});

describe('applySafetyGuard — the honesty rail', () => {
  it('clean PR keeps the LLM approve', () => {
    const s = signalsFrom(makePr({ checks_state: 'success' }), CLEAN_DIFF);
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('approve');
    expect(g.risks).not.toContain(GUARD_RISK.checks_failing);
  });

  it('TEETH: failing checks force approve → request_changes (defective PR never approved)', () => {
    const s = signalsFrom(makePr({ checks_state: 'failure' }), CLEAN_DIFF);
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('request_changes');
    expect(g.risks).toContain(GUARD_RISK.checks_failing);
  });

  it('TEETH: a planted secret forces approve → reject', () => {
    const secretDiff = '+++ b/c\n@@\n+const k = "AKIAIOSFODNN7EXAMPLE";';
    const s = signalsFrom(makePr({ checks_state: 'success' }), secretDiff);
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('reject');
    expect(g.risks).toContain(GUARD_RISK.secret);
  });

  it('TEETH: an empty diff cannot be approved', () => {
    const s = signalsFrom(makePr({ checks_state: 'success' }), '');
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('request_changes');
    expect(g.risks).toContain(GUARD_RISK.empty_diff);
  });

  it('never UPGRADES: an LLM reject stays reject on a clean PR', () => {
    const s = signalsFrom(makePr({ checks_state: 'success' }), CLEAN_DIFF);
    const g = applySafetyGuard({ ...cleanRaw, recommendation: 'reject' }, s);
    expect(g.recommendation).toBe('reject');
  });

  it('no-tests is a soft risk, not a hard downgrade', () => {
    const noTestDiff = 'diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@\n+const x = 1;';
    const s = signalsFrom(makePr({ checks_state: 'success' }), noTestDiff);
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('approve');
    expect(g.risks).toContain(GUARD_RISK.no_tests);
  });

  it('truncation is a soft risk: flagged but does NOT downgrade approve', () => {
    const s = computeReviewSignals({ pr: makePr({ checks_state: 'success' }), diff: CLEAN_DIFF, maxChars: 10 });
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('approve');
    expect(g.risks).toContain(GUARD_RISK.truncated);
  });

  it('truncation does NOT weaken hard floors (secret in a truncated diff still rejects)', () => {
    const secretDiff = '+++ b/c\n@@\n+const k = "AKIAIOSFODNN7EXAMPLE";';
    const s = computeReviewSignals({ pr: makePr({ checks_state: 'success' }), diff: secretDiff, maxChars: 5 });
    const g = applySafetyGuard(cleanRaw, s);
    expect(g.recommendation).toBe('reject'); // secret floor still applies
    expect(g.risks).toContain(GUARD_RISK.secret);
    expect(g.risks).toContain(GUARD_RISK.truncated);
  });

  it('de-duplicates LLM + guard risks', () => {
    const s = signalsFrom(makePr({ checks_state: 'failure' }), CLEAN_DIFF);
    const g = applySafetyGuard({ ...cleanRaw, risks: [GUARD_RISK.checks_failing] }, s);
    const count = g.risks.filter((r) => r === GUARD_RISK.checks_failing).length;
    expect(count).toBe(1);
  });
});

describe('assembleReport', () => {
  it('produces a guarded report with deterministic checksObserved', () => {
    const s = signalsFrom(makePr({ checks_state: 'failure', mergeable_state: 'not_mergeable' }), CLEAN_DIFF);
    const report = assembleReport(cleanRaw, s);
    expect(report.recommendation).toBe('request_changes');
    expect(report.checksObserved.checks_state).toBe('failure');
    expect(report.checksObserved.mergeable_state).toBe('not_mergeable');
    expect(report.checksObserved.tests_touched).toBe(true);
    expect(report.summary).toBe(cleanRaw.summary);
  });
});

describe('reportGatesAutoApprove', () => {
  it('only approve passes', () => {
    expect(reportGatesAutoApprove({ recommendation: 'approve' })).toBe(true);
    expect(reportGatesAutoApprove({ recommendation: 'request_changes' })).toBe(false);
    expect(reportGatesAutoApprove({ recommendation: 'reject' })).toBe(false);
  });
});

describe('isStoredPrReviewReport', () => {
  it('accepts a well-formed row', () => {
    expect(
      isStoredPrReviewReport({
        harness_slug: 'h',
        pr_number: 1,
        pr_url: 'u',
        recommendation: 'approve',
        summary: 's',
        rationale: 'r',
        risks: [],
        checks_observed: {},
        model: 'm',
      }),
    ).toBe(true);
  });
  it('rejects bad rows', () => {
    expect(isStoredPrReviewReport(null)).toBe(false);
    expect(isStoredPrReviewReport({ harness_slug: 'h', pr_number: 1.5 })).toBe(false);
    expect(
      isStoredPrReviewReport({
        harness_slug: 'h',
        pr_number: 1,
        pr_url: 'u',
        recommendation: 'bad',
        summary: 's',
        rationale: 'r',
        risks: [],
        checks_observed: {},
        model: 'm',
      }),
    ).toBe(false);
  });
});
