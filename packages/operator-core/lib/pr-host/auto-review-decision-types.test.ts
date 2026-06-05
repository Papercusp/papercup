import { describe, expect, it } from 'vitest';
import {
  AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS,
  CONFIG_SKIP_REASONS,
  DEFINITIVE_CHECKS_STATES,
  STATE_SKIP_REASONS,
  TRANSIENT_CHECKS_STATES,
  decideAutoReview,
  isChecksGreen,
  wouldFireIfTrusted,
  type AutoReviewSettings,
} from './auto-review-decision-types';
import type { Pr } from './types';

function makePr(over: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/x/y', number: 1 },
    state: 'open',
    title: 'feat: thing',
    body: null,
    head_ref: 'feature/x',
    base_ref: 'main',
    head_sha: 'abcdef',
    merge_commit_sha: null,
    author: { github_user_id: 100, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'success',
    mergeable_state: 'mergeable',
    is_draft: false,
    url: 'https://github.com/x/y/pull/1',
    updated_at: 1716_000_000_000,
    ...over,
  };
}

function makeSettings(over: Partial<AutoReviewSettings> = {}): AutoReviewSettings {
  return {
    pr_reviewer_role_enabled: true,
    auto_review: true,
    auto_merge: false,
    trust_list: new Set([100]),
    viewer_github_user_id: 999,
    ...over,
  };
}

describe('decideAutoReview — skip cases', () => {
  it('skips when pr_reviewer_role_enabled is false', () => {
    const d = decideAutoReview(makePr(), makeSettings({ pr_reviewer_role_enabled: false }));
    expect(d).toEqual({ kind: 'skip', reason: 'pr_reviewer_role_disabled' });
  });

  it('skips when auto_review is off', () => {
    const d = decideAutoReview(makePr(), makeSettings({ auto_review: false }));
    expect(d).toEqual({ kind: 'skip', reason: 'auto_review_off' });
  });

  it('skips when PR is not open', () => {
    for (const state of ['merged', 'closed', 'gone'] as const) {
      const d = decideAutoReview(makePr({ state }), makeSettings());
      expect(d).toEqual({ kind: 'skip', reason: 'pr_state_not_open' });
    }
  });

  it('skips when PR is draft', () => {
    const d = decideAutoReview(makePr({ is_draft: true }), makeSettings());
    expect(d).toEqual({ kind: 'skip', reason: 'pr_is_draft' });
  });

  it('skips when viewer is the PR author', () => {
    const d = decideAutoReview(
      makePr({ author: { github_user_id: 999, github_login: 'me' } }),
      makeSettings({ trust_list: new Set([999]) }),
    );
    expect(d).toEqual({ kind: 'skip', reason: 'pr_author_is_viewer' });
  });

  it('skips when PR author is not in trust list', () => {
    const d = decideAutoReview(makePr(), makeSettings({ trust_list: new Set() }));
    expect(d).toEqual({ kind: 'skip', reason: 'pr_author_not_trusted' });
  });

  it('skips when PR review_decision is approved (idempotency)', () => {
    const d = decideAutoReview(makePr({ review_decision: 'approved' }), makeSettings());
    expect(d).toEqual({ kind: 'skip', reason: 'already_approved_by_viewer' });
  });

  it('skips when PR review_decision is changes_requested', () => {
    const d = decideAutoReview(makePr({ review_decision: 'changes_requested' }), makeSettings());
    expect(d).toEqual({ kind: 'skip', reason: 'viewer_requested_changes' });
  });
});

describe('decideAutoReview — approve cases', () => {
  it('approves a clean PR with auto_merge off', () => {
    const d = decideAutoReview(makePr(), makeSettings({ auto_merge: false }));
    expect(d.kind).toBe('approve');
    expect(d.kind === 'approve' && d.approval_body).toContain('@alice');
    expect(d.kind === 'approve' && d.approval_body).toContain('trust list');
  });

  it('approves but does not auto-merge when checks not green', () => {
    const d = decideAutoReview(
      makePr({ checks_state: 'pending' }),
      makeSettings({ auto_merge: true }),
    );
    expect(d.kind).toBe('approve');
  });

  it('approves but does not auto-merge when not mergeable', () => {
    const d = decideAutoReview(
      makePr({ mergeable_state: 'not_mergeable' }),
      makeSettings({ auto_merge: true }),
    );
    expect(d.kind).toBe('approve');
  });

  it('approves but does not auto-merge when mergeable_state=unknown', () => {
    const d = decideAutoReview(
      makePr({ mergeable_state: 'unknown' }),
      makeSettings({ auto_merge: true }),
    );
    expect(d.kind).toBe('approve');
  });
});

describe('decideAutoReview — approve_and_merge case', () => {
  it('fires when auto_merge=true + checks green + mergeable', () => {
    const d = decideAutoReview(makePr(), makeSettings({ auto_merge: true }));
    expect(d.kind).toBe('approve_and_merge');
    expect(d.kind === 'approve_and_merge' && d.approval_body).toContain('@alice');
  });

  it('accepts review_decision=commented (compatible)', () => {
    const d = decideAutoReview(
      makePr({ review_decision: 'commented' }),
      makeSettings({ auto_merge: true }),
    );
    expect(d.kind).toBe('approve_and_merge');
  });
});

describe('isChecksGreen', () => {
  it('only success counts as green', () => {
    expect(isChecksGreen('success')).toBe(true);
    expect(isChecksGreen('pending')).toBe(false);
    expect(isChecksGreen('unknown')).toBe(false);
    expect(isChecksGreen('failure')).toBe(false);
    expect(isChecksGreen('error')).toBe(false);
    expect(isChecksGreen('cancelled')).toBe(false);
  });
});

describe('wouldFireIfTrusted', () => {
  it('returns true when only the trust-list gate blocks', () => {
    expect(wouldFireIfTrusted(makePr(), makeSettings({ trust_list: new Set() }))).toBe(true);
  });

  it('returns false when author is already trusted (would fire NOW, not "if added")', () => {
    expect(wouldFireIfTrusted(makePr(), makeSettings({ trust_list: new Set([100]) }))).toBe(false);
  });

  it('returns false when another gate also blocks', () => {
    expect(
      wouldFireIfTrusted(makePr({ is_draft: true }), makeSettings({ trust_list: new Set() })),
    ).toBe(false);
    expect(
      wouldFireIfTrusted(makePr({ state: 'merged' }), makeSettings({ trust_list: new Set() })),
    ).toBe(false);
    expect(
      wouldFireIfTrusted(
        makePr(),
        makeSettings({ trust_list: new Set(), pr_reviewer_role_enabled: false }),
      ),
    ).toBe(false);
    expect(
      wouldFireIfTrusted(
        makePr(),
        makeSettings({ trust_list: new Set(), auto_review: false }),
      ),
    ).toBe(false);
  });

  it('returns false when viewer is the author', () => {
    expect(
      wouldFireIfTrusted(
        makePr({ author: { github_user_id: 999, github_login: 'me' } }),
        makeSettings({ trust_list: new Set() }),
      ),
    ).toBe(false);
  });
});

describe('CONFIG_SKIP_REASONS', () => {
  it('contains the three user-flippable reasons', () => {
    expect(CONFIG_SKIP_REASONS.has('pr_reviewer_role_disabled')).toBe(true);
    expect(CONFIG_SKIP_REASONS.has('auto_review_off')).toBe(true);
    expect(CONFIG_SKIP_REASONS.has('pr_author_not_trusted')).toBe(true);
  });

  it('does NOT contain state-only reasons', () => {
    expect(CONFIG_SKIP_REASONS.has('pr_state_not_open')).toBe(false);
    expect(CONFIG_SKIP_REASONS.has('pr_is_draft')).toBe(false);
  });
});

describe('STATE_SKIP_REASONS', () => {
  it('contains every state-only reason', () => {
    expect(STATE_SKIP_REASONS.has('pr_state_not_open')).toBe(true);
    expect(STATE_SKIP_REASONS.has('pr_author_is_viewer')).toBe(true);
    expect(STATE_SKIP_REASONS.has('already_approved_by_viewer')).toBe(true);
    expect(STATE_SKIP_REASONS.has('viewer_requested_changes')).toBe(true);
    expect(STATE_SKIP_REASONS.has('pr_is_draft')).toBe(true);
  });

  it('and CONFIG_SKIP_REASONS partition the union (every reason in one or the other)', () => {
    const all = [...CONFIG_SKIP_REASONS, ...STATE_SKIP_REASONS];
    // Exactly 8 union members (3 config + 5 state).
    expect(all.length).toBe(8);
    expect(new Set(all).size).toBe(8); // no dupes
  });
});

describe('TRANSIENT_CHECKS_STATES', () => {
  it('lists pending + unknown as transient', () => {
    expect(TRANSIENT_CHECKS_STATES.has('pending')).toBe(true);
    expect(TRANSIENT_CHECKS_STATES.has('unknown')).toBe(true);
    expect(TRANSIENT_CHECKS_STATES.has('success')).toBe(false);
    expect(TRANSIENT_CHECKS_STATES.has('failure')).toBe(false);
  });
});

describe('DEFINITIVE_CHECKS_STATES', () => {
  it('is the complement of TRANSIENT_CHECKS_STATES', () => {
    expect(DEFINITIVE_CHECKS_STATES.has('success')).toBe(true);
    expect(DEFINITIVE_CHECKS_STATES.has('failure')).toBe(true);
    expect(DEFINITIVE_CHECKS_STATES.has('error')).toBe(true);
    expect(DEFINITIVE_CHECKS_STATES.has('cancelled')).toBe(true);
    expect(DEFINITIVE_CHECKS_STATES.has('pending')).toBe(false);
    expect(DEFINITIVE_CHECKS_STATES.has('unknown')).toBe(false);
  });
});

describe('AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS', () => {
  it('contains none + commented', () => {
    expect(AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS.has('none')).toBe(true);
    expect(AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS.has('commented')).toBe(true);
  });

  it('does NOT contain approved or changes_requested', () => {
    expect(AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS.has('approved')).toBe(false);
    expect(AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS.has('changes_requested')).toBe(false);
  });
});
