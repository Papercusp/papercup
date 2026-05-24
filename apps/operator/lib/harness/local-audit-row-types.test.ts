import { describe, expect, it } from 'vitest';
import {
  AUTO_REVIEW_AUDIT_ACTIONS,
  CLAIM_AUDIT_OUTCOMES,
  LOCAL_AUDIT_TABLE_NAMES,
  WEBHOOK_AUDIT_MESSAGE_MAX,
  buildTrustListSet,
  clampWebhookErrorMessage,
  isAutoReviewAuditRow,
  isClaimAuditRow,
  isInsightsFirstVisitRow,
  isTrusted,
  isTrustedAuthorRow,
  isWebhookAuditRow,
  shouldForceInsightsRedirect,
  type AutoReviewAuditRow,
  type ClaimAuditRow,
  type InsightsFirstVisitRow,
  type TrustedAuthorRow,
  type WebhookAuditRow,
} from './local-audit-row-types';

describe('LOCAL_AUDIT_TABLE_NAMES', () => {
  it('lists all 5 tables', () => {
    expect([...LOCAL_AUDIT_TABLE_NAMES]).toEqual([
      'auto_review_audit',
      'claim_audit',
      'webhook_audit',
      'insights_first_visit',
      'trusted_authors',
    ]);
  });
});

// ─── auto_review_audit ─────────────────────────────────────────────

describe('AutoReviewAuditRow', () => {
  function make(over: Partial<AutoReviewAuditRow> = {}): AutoReviewAuditRow {
    return {
      harness_slug: 'papercup',
      pr_number: 42,
      action: 'approved',
      ts: 1716_000_000_000,
      ...over,
    };
  }

  it('accepts approved + merged', () => {
    expect(isAutoReviewAuditRow(make())).toBe(true);
    expect(isAutoReviewAuditRow(make({ action: 'merged' }))).toBe(true);
  });

  it('rejects unknown action', () => {
    expect(isAutoReviewAuditRow({ ...make(), action: 'rejected' })).toBe(false);
  });

  it('rejects non-positive pr_number', () => {
    expect(isAutoReviewAuditRow(make({ pr_number: 0 }))).toBe(false);
    expect(isAutoReviewAuditRow(make({ pr_number: -1 }))).toBe(false);
    expect(isAutoReviewAuditRow(make({ pr_number: 1.5 }))).toBe(false);
  });

  it('rejects empty harness_slug + bad ts', () => {
    expect(isAutoReviewAuditRow(make({ harness_slug: '' }))).toBe(false);
    expect(isAutoReviewAuditRow(make({ ts: 0 }))).toBe(false);
    expect(isAutoReviewAuditRow(make({ ts: Number.NaN }))).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isAutoReviewAuditRow(null)).toBe(false);
    expect(isAutoReviewAuditRow('x')).toBe(false);
  });

  it('AUTO_REVIEW_AUDIT_ACTIONS has both', () => {
    expect([...AUTO_REVIEW_AUDIT_ACTIONS]).toEqual(['approved', 'merged']);
  });
});

// ─── claim_audit ──────────────────────────────────────────────────

describe('ClaimAuditRow', () => {
  function make(over: Partial<ClaimAuditRow> = {}): ClaimAuditRow {
    return {
      harness_slug: 'papercup',
      feature_id: 'F-001',
      attempt_ts: 1716_000_000_000,
      outcome: 'won',
      ...over,
    };
  }

  it('accepts won / lost / error', () => {
    for (const outcome of ['won', 'lost', 'error'] as const) {
      expect(isClaimAuditRow(make({ outcome }))).toBe(true);
    }
  });

  it('rejects unknown outcome', () => {
    expect(isClaimAuditRow({ ...make(), outcome: 'pending' })).toBe(false);
  });

  it('rejects empty harness/feature + bad ts', () => {
    expect(isClaimAuditRow(make({ harness_slug: '' }))).toBe(false);
    expect(isClaimAuditRow(make({ feature_id: '' }))).toBe(false);
    expect(isClaimAuditRow(make({ attempt_ts: 0 }))).toBe(false);
  });

  it('CLAIM_AUDIT_OUTCOMES has 3 values', () => {
    expect([...CLAIM_AUDIT_OUTCOMES]).toEqual(['won', 'lost', 'error']);
  });
});

// ─── webhook_audit ────────────────────────────────────────────────

describe('WebhookAuditRow', () => {
  function make(over: Partial<WebhookAuditRow> = {}): WebhookAuditRow {
    return {
      harness_slug: 'papercup',
      attempt_ts: 1716_000_000_000,
      status: 500,
      error_message: 'service unavailable',
      notification_kind: 'feature_shipped',
      ...over,
    };
  }

  it('accepts well-formed row', () => {
    expect(isWebhookAuditRow(make())).toBe(true);
  });

  it('accepts status=0 for never-reached-network', () => {
    expect(isWebhookAuditRow(make({ status: 0 }))).toBe(true);
  });

  it('rejects negative status', () => {
    expect(isWebhookAuditRow(make({ status: -1 }))).toBe(false);
  });

  it('rejects empty notification_kind', () => {
    expect(isWebhookAuditRow(make({ notification_kind: '' }))).toBe(false);
  });

  it('rejects over-length error_message', () => {
    expect(
      isWebhookAuditRow(make({ error_message: 'a'.repeat(WEBHOOK_AUDIT_MESSAGE_MAX + 1) })),
    ).toBe(false);
  });

  it('accepts at-limit error_message', () => {
    expect(
      isWebhookAuditRow(make({ error_message: 'a'.repeat(WEBHOOK_AUDIT_MESSAGE_MAX) })),
    ).toBe(true);
  });

  it('WEBHOOK_AUDIT_MESSAGE_MAX is 500', () => {
    expect(WEBHOOK_AUDIT_MESSAGE_MAX).toBe(500);
  });
});

describe('clampWebhookErrorMessage', () => {
  it('truncates at WEBHOOK_AUDIT_MESSAGE_MAX', () => {
    const long = 'a'.repeat(WEBHOOK_AUDIT_MESSAGE_MAX + 100);
    expect(clampWebhookErrorMessage(long).length).toBe(WEBHOOK_AUDIT_MESSAGE_MAX);
  });

  it('passes short strings unchanged', () => {
    expect(clampWebhookErrorMessage('short')).toBe('short');
  });

  it('returns "" for non-string', () => {
    // @ts-expect-error
    expect(clampWebhookErrorMessage(null)).toBe('');
    // @ts-expect-error
    expect(clampWebhookErrorMessage(42)).toBe('');
  });
});

// ─── insights_first_visit ─────────────────────────────────────────

describe('InsightsFirstVisitRow', () => {
  function make(over: Partial<InsightsFirstVisitRow> = {}): InsightsFirstVisitRow {
    return {
      harness_slug: 'papercup',
      github_user_id: 12345,
      seen_at_ts: null,
      ...over,
    };
  }

  it('accepts unseen row (seen_at_ts=null)', () => {
    expect(isInsightsFirstVisitRow(make())).toBe(true);
  });

  it('accepts seen row', () => {
    expect(isInsightsFirstVisitRow(make({ seen_at_ts: 1716_000_001_000 }))).toBe(true);
  });

  it('rejects empty harness_slug + non-positive user_id', () => {
    expect(isInsightsFirstVisitRow(make({ harness_slug: '' }))).toBe(false);
    expect(isInsightsFirstVisitRow(make({ github_user_id: 0 }))).toBe(false);
    expect(isInsightsFirstVisitRow(make({ github_user_id: 1.5 }))).toBe(false);
  });

  it('rejects non-finite or zero seen_at_ts', () => {
    expect(isInsightsFirstVisitRow(make({ seen_at_ts: 0 }))).toBe(false);
    expect(isInsightsFirstVisitRow(make({ seen_at_ts: Number.NaN }))).toBe(false);
  });
});

describe('shouldForceInsightsRedirect', () => {
  it('true when unseen', () => {
    expect(
      shouldForceInsightsRedirect({
        harness_slug: 'x',
        github_user_id: 1,
        seen_at_ts: null,
      }),
    ).toBe(true);
  });

  it('false when seen', () => {
    expect(
      shouldForceInsightsRedirect({
        harness_slug: 'x',
        github_user_id: 1,
        seen_at_ts: 1,
      }),
    ).toBe(false);
  });
});

// ─── trusted_authors ───────────────────────────────────────────────

describe('TrustedAuthorRow', () => {
  function make(over: Partial<TrustedAuthorRow> = {}): TrustedAuthorRow {
    return {
      harness_slug: 'papercup',
      trusted_github_user_id: 200,
      trusted_at: 1716_000_000_000,
      trusted_by_github_user_id: 100,
      ...over,
    };
  }

  it('accepts well-formed row', () => {
    expect(isTrustedAuthorRow(make())).toBe(true);
  });

  it('rejects non-positive ids + bad ts', () => {
    expect(isTrustedAuthorRow(make({ trusted_github_user_id: 0 }))).toBe(false);
    expect(isTrustedAuthorRow(make({ trusted_by_github_user_id: 0 }))).toBe(false);
    expect(isTrustedAuthorRow(make({ trusted_at: 0 }))).toBe(false);
  });
});

describe('buildTrustListSet', () => {
  it('builds a set of trusted_github_user_ids filtered to the harness', () => {
    const rows: TrustedAuthorRow[] = [
      {
        harness_slug: 'papercup',
        trusted_github_user_id: 100,
        trusted_at: 1,
        trusted_by_github_user_id: 1,
      },
      {
        harness_slug: 'papercup',
        trusted_github_user_id: 200,
        trusted_at: 1,
        trusted_by_github_user_id: 1,
      },
      {
        harness_slug: 'other',
        trusted_github_user_id: 300,
        trusted_at: 1,
        trusted_by_github_user_id: 1,
      },
    ];
    const set = buildTrustListSet(rows, 'papercup');
    expect(set.has(100)).toBe(true);
    expect(set.has(200)).toBe(true);
    expect(set.has(300)).toBe(false);
    expect(set.size).toBe(2);
  });

  it('returns empty set when no rows match', () => {
    expect(buildTrustListSet([], 'x').size).toBe(0);
  });
});

describe('isTrusted', () => {
  const rows: TrustedAuthorRow[] = [
    {
      harness_slug: 'papercup',
      trusted_github_user_id: 100,
      trusted_at: 1,
      trusted_by_github_user_id: 1,
    },
  ];

  it('true when (harness, user) match', () => {
    expect(isTrusted(rows, 'papercup', 100)).toBe(true);
  });

  it('false when user not in list', () => {
    expect(isTrusted(rows, 'papercup', 200)).toBe(false);
  });

  it('false when harness differs', () => {
    expect(isTrusted(rows, 'other', 100)).toBe(false);
  });

  it('false when no rows', () => {
    expect(isTrusted([], 'x', 1)).toBe(false);
  });
});
