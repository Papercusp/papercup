/**
 * pr-row-data — PR-3 report-GUI helpers (PLAN-pr-system-completion-dogfood).
 *
 * Teeth-verified honesty discipline: `computeAutoStatus` must NEVER report a
 * green "will auto-merge" unless every real gate clears, and a defective /
 * unreviewed / untrusted / red-checks PR must surface the HONEST blocker —
 * the GUI can then never present a misleading "merged"/"approved" state.
 */

import { describe, expect, it } from 'vitest';
import {
  computeAutoStatus,
  recommendationLabel,
  recommendationTone,
  AUTO_BLOCKER,
  type PrRowData,
  type PrRowReport,
  type AutoModeSettings,
} from './pr-row-data';

function makeReport(overrides: Partial<PrRowReport> = {}): PrRowReport {
  return {
    recommendation: 'approve',
    summary: 'Adds a widget.',
    rationale: 'Looks sound.',
    risks: [],
    checksObserved: { checks_state: 'success', mergeable_state: 'mergeable' } as PrRowReport['checksObserved'],
    headSha: 'abc1234',
    stale: false,
    model: 'claude',
    reviewedAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeRow(
  overrides: Partial<
    Pick<PrRowData, 'state' | 'check_conclusion' | 'review_decision' | 'trusted' | 'report'>
  > = {},
): Pick<PrRowData, 'state' | 'check_conclusion' | 'review_decision' | 'trusted' | 'report'> {
  return {
    state: 'open',
    check_conclusion: 'success',
    review_decision: 'none',
    trusted: true,
    report: makeReport(),
    ...overrides,
  };
}

const AUTO_ON: AutoModeSettings = { reviewerRoleEnabled: true, autoReview: true, autoMerge: true };

describe('recommendation display helpers', () => {
  it('labels each recommendation', () => {
    expect(recommendationLabel('approve')).toBe('Approve');
    expect(recommendationLabel('request_changes')).toBe('Request changes');
    expect(recommendationLabel('reject')).toBe('Reject');
  });
  it('maps recommendation → tone', () => {
    expect(recommendationTone('approve')).toBe('ok');
    expect(recommendationTone('request_changes')).toBe('warn');
    expect(recommendationTone('reject')).toBe('bad');
  });
});

describe('computeAutoStatus — manual mode', () => {
  it('role disabled → manual (no auto promises)', () => {
    expect(computeAutoStatus(makeRow(), { reviewerRoleEnabled: false, autoReview: true, autoMerge: true })).toEqual({
      mode: 'manual',
    });
  });
  it('auto_review off → manual', () => {
    expect(computeAutoStatus(makeRow(), { reviewerRoleEnabled: true, autoReview: false, autoMerge: true })).toEqual({
      mode: 'manual',
    });
  });
});

describe('computeAutoStatus — auto mode, all gates clear', () => {
  it('trusted + approve + green checks + auto_merge → willMerge', () => {
    expect(computeAutoStatus(makeRow(), AUTO_ON)).toEqual({ mode: 'auto', willMerge: true });
  });
  it('auto_merge off → approves only, NOT willMerge, honest blocker', () => {
    const s = computeAutoStatus(makeRow(), { reviewerRoleEnabled: true, autoReview: true, autoMerge: false });
    expect(s).toEqual({ mode: 'auto', willMerge: false, blockers: [AUTO_BLOCKER.auto_merge_off] });
  });
});

describe('computeAutoStatus — honest blockers (never a false green)', () => {
  it('untrusted author blocks', () => {
    const s = computeAutoStatus(makeRow({ trusted: false }), AUTO_ON);
    expect(s.mode).toBe('auto');
    expect(s.mode === 'auto' && s.willMerge).toBe(false);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.untrusted);
  });

  it('failing checks block (the S0 checks gate)', () => {
    const s = computeAutoStatus(makeRow({ check_conclusion: 'failure' }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.checks_failing);
  });

  it('pending checks block (only success is green)', () => {
    const s = computeAutoStatus(makeRow({ check_conclusion: 'pending' }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.checks_pending);
  });

  it('null/unknown checks block', () => {
    const s = computeAutoStatus(makeRow({ check_conclusion: null }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.checks_unknown);
  });

  it('no agent report blocks (cannot auto-approve unreviewed)', () => {
    const s = computeAutoStatus(makeRow({ report: null }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.report_missing);
  });

  it('report recommending request_changes blocks (defective PR never auto-approved)', () => {
    const s = computeAutoStatus(makeRow({ report: makeReport({ recommendation: 'request_changes' }) }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.report_not_approve);
  });

  it('report recommending reject blocks', () => {
    const s = computeAutoStatus(makeRow({ report: makeReport({ recommendation: 'reject' }) }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.report_not_approve);
  });

  it('stale report blocks (reviewed an earlier commit)', () => {
    const s = computeAutoStatus(makeRow({ report: makeReport({ stale: true }) }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.report_stale);
  });

  it('changes-requested review blocks', () => {
    const s = computeAutoStatus(makeRow({ review_decision: 'changes_requested' }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.changes_requested);
  });

  it('closed/non-open PR blocks', () => {
    const s = computeAutoStatus(makeRow({ state: 'closed' }), AUTO_ON);
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toContain(AUTO_BLOCKER.not_open);
  });

  it('a multiply-defective PR lists every blocker (no early green)', () => {
    const s = computeAutoStatus(
      makeRow({ trusted: false, check_conclusion: 'failure', report: makeReport({ recommendation: 'reject' }) }),
      AUTO_ON,
    );
    expect(s.mode === 'auto' && !s.willMerge && s.blockers).toEqual(
      expect.arrayContaining([
        AUTO_BLOCKER.untrusted,
        AUTO_BLOCKER.report_not_approve,
        AUTO_BLOCKER.checks_failing,
      ]),
    );
    expect(s.mode === 'auto' && s.willMerge).toBe(false);
  });
});
