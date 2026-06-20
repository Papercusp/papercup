/**
 * PrReviewerSettings.test.ts — Phase 8 P-049. Unit tests for the pure
 * UI helpers in PrReviewerSettings.tsx:
 *   - MERGE_METHOD_OPTIONS  (the merge-method <select> options)
 *   - toggleToPayload       (toggle → POST body mapping)
 *   - auditActionLabel      (audit action → human label, P-049c)
 *   - auditActionTone       (audit action → row tint bucket)
 */

import { describe, it, expect } from 'vitest';
import {
  MERGE_METHOD_OPTIONS,
  toggleToPayload,
  auditActionLabel,
  auditActionTone,
  formatAuditDetail,
} from './PrReviewerSettings';
import { PR_MERGE_METHODS } from '@papercusp/operator-core/lib/pr-host/types';

describe('MERGE_METHOD_OPTIONS', () => {
  it('covers exactly the canonical merge methods, squash first', () => {
    expect(MERGE_METHOD_OPTIONS.map((o) => o.value)).toEqual([...PR_MERGE_METHODS]);
    expect(MERGE_METHOD_OPTIONS[0].value).toBe('squash');
  });
  it('every option has a non-empty label', () => {
    for (const o of MERGE_METHOD_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });
});

describe('toggleToPayload', () => {
  it('builds a single-field boolean patch', () => {
    expect(toggleToPayload('auto_review', true)).toEqual({ auto_review: true });
    expect(toggleToPayload('auto_merge', false)).toEqual({ auto_merge: false });
    expect(toggleToPayload('pr_reviewer_role_enabled', true)).toEqual({
      pr_reviewer_role_enabled: true,
    });
  });
  it('builds a merge_method patch', () => {
    expect(toggleToPayload('merge_method', 'rebase')).toEqual({ merge_method: 'rebase' });
  });
});

describe('auditActionLabel', () => {
  it('maps known actions to friendly labels', () => {
    expect(auditActionLabel('auto_approve')).toBe('Auto-approved');
    expect(auditActionLabel('auto_merge')).toBe('Auto-merged');
    expect(auditActionLabel('manual_approve')).toBe('Approved');
    expect(auditActionLabel('manual_merge')).toBe('Merged');
    expect(auditActionLabel('skipped_untrusted')).toBe('Skipped (untrusted author)');
    expect(auditActionLabel('skipped_revoked')).toBe('Refused (revoked contributor)');
    expect(auditActionLabel('skipped_checks_failing')).toBe('Skipped (checks failing)');
    expect(auditActionLabel('error')).toBe('Error');
  });
  it('passes through an unknown action unchanged', () => {
    expect(auditActionLabel('mystery')).toBe('mystery');
  });
});

describe('auditActionTone', () => {
  it('positive actions are ok', () => {
    for (const a of ['auto_approve', 'auto_merge', 'manual_approve', 'manual_merge']) {
      expect(auditActionTone(a)).toBe('ok');
    }
  });
  it('error is bad', () => {
    expect(auditActionTone('error')).toBe('bad');
  });
  it('skipped actions are muted', () => {
    expect(auditActionTone('skipped_untrusted')).toBe('muted');
    expect(auditActionTone('skipped_revoked')).toBe('muted');
    expect(auditActionTone('skipped_checks_failing')).toBe('muted');
  });
  it('unknown actions default to warn', () => {
    expect(auditActionTone('weird')).toBe('warn');
  });
});

describe('formatAuditDetail (PR-3 — agent-review audit rendering)', () => {
  const agentDetail = JSON.stringify({
    model: 'claude',
    head_sha: 'abc1234def5678',
    recommendation: 'approve',
    feature_id: 'F-1',
    tokens_in: 1200,
    tokens_out: 300,
    risks: 2,
  });

  it('formats an agent_review JSON blob into a readable string', () => {
    const out = formatAuditDetail('agent_review', agentDetail);
    expect(out).toBe('approve · model claude · @abc1234 · F-1 · 2 risks');
  });

  it('singularises a single risk and includes an error for agent_review_error', () => {
    const d = JSON.stringify({ model: 'claude', recommendation: 'reject', risks: 1, error: 'diff fetch failed' });
    expect(formatAuditDetail('agent_review_error', d)).toBe(
      'reject · model claude · 1 risk · error: diff fetch failed',
    );
  });

  it('omits zero risks and absent fields', () => {
    const d = JSON.stringify({ recommendation: 'approve', risks: 0 });
    expect(formatAuditDetail('agent_review', d)).toBe('approve');
  });

  it('falls back to the raw string when the agent detail is not JSON', () => {
    expect(formatAuditDetail('agent_review', 'not json at all')).toBe('not json at all');
  });

  it('leaves NON-agent audit details untouched (no parsing)', () => {
    expect(formatAuditDetail('auto_merge', 'merged via squash')).toBe('merged via squash');
    expect(formatAuditDetail('skipped_untrusted', '{"x":1}')).toBe('{"x":1}');
  });

  it('returns empty string for a null/empty detail', () => {
    expect(formatAuditDetail('agent_review', null)).toBe('');
    expect(formatAuditDetail('agent_review', '')).toBe('');
  });
});
