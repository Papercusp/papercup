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
    expect(auditActionTone('skipped_checks_failing')).toBe('muted');
  });
  it('unknown actions default to warn', () => {
    expect(auditActionTone('weird')).toBe('warn');
  });
});
