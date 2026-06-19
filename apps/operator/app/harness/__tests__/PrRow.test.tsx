/**
 * @vitest-environment jsdom
 *
 * PrRow — single-PR-row rendering tests (Phase 7 P-043).
 *
 * Covers the prop-driven render across PR states:
 *  - checks badge: success / failure / pending / other / null (none).
 *  - review decision badge: approved / changes_requested / commented / dismissed / none.
 *  - trust badge gating (trusted + reviewerRoleEnabled).
 *  - action buttons gating (reviewerRoleEnabled + state==='open') and callbacks.
 *  - the `gone` (404-demoted) state: "PR gone" tag, dimmed, no actions.
 *
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrRow, type PrRowData } from '../PrRow';

afterEach(() => cleanup());

function makePr(overrides: Partial<PrRowData> = {}): PrRowData {
  return {
    remote: 'origin',
    number: 42,
    title: 'Add the widget',
    author_login: 'alice',
    author_github_id: 1001,
    html_url: 'https://github.com/acme/repo/pull/42',
    state: 'open',
    review_decision: 'none',
    check_conclusion: null,
    trusted: false,
    reviewerRoleEnabled: false,
    ...overrides,
  };
}

describe('PrRow — basics', () => {
  it('renders the PR number, title, and author login', () => {
    render(<PrRow pr={makePr()} />);
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('Add the widget')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
  });

  it('renders an external-link anchor pointing at html_url with an aria-label', () => {
    render(<PrRow pr={makePr()} />);
    const link = screen.getByLabelText('Open PR #42 on GitHub');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/repo/pull/42');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('PrRow — checks badge (check_conclusion)', () => {
  it('null conclusion renders no checks badge', () => {
    render(<PrRow pr={makePr({ check_conclusion: null })} />);
    expect(screen.queryByText('checks')).toBeNull();
    expect(screen.queryByText('failed')).toBeNull();
    expect(screen.queryByText('pending')).toBeNull();
  });

  it('success conclusion renders the "checks" badge', () => {
    render(<PrRow pr={makePr({ check_conclusion: 'success' })} />);
    expect(screen.getByText('checks')).toBeTruthy();
  });

  it('failure conclusion renders the "failed" badge', () => {
    render(<PrRow pr={makePr({ check_conclusion: 'failure' })} />);
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('pending conclusion renders the "pending" badge', () => {
    render(<PrRow pr={makePr({ check_conclusion: 'pending' })} />);
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('an unrecognised conclusion renders the raw value (fallback branch)', () => {
    render(<PrRow pr={makePr({ check_conclusion: 'cancelled' })} />);
    expect(screen.getByText('cancelled')).toBeTruthy();
  });
});

describe('PrRow — review decision badge', () => {
  it('none renders no review badge', () => {
    render(<PrRow pr={makePr({ review_decision: 'none' })} />);
    expect(screen.queryByText(/approved/)).toBeNull();
    expect(screen.queryByText(/changes requested/)).toBeNull();
  });

  it('approved renders "✓ approved"', () => {
    render(<PrRow pr={makePr({ review_decision: 'approved' })} />);
    expect(screen.getByText('✓ approved')).toBeTruthy();
  });

  it('changes_requested renders "✗ changes requested"', () => {
    render(<PrRow pr={makePr({ review_decision: 'changes_requested' })} />);
    expect(screen.getByText('✗ changes requested')).toBeTruthy();
  });

  it('commented renders the raw decision string', () => {
    render(<PrRow pr={makePr({ review_decision: 'commented' })} />);
    expect(screen.getByText('commented')).toBeTruthy();
  });

  it('dismissed renders the raw decision string', () => {
    render(<PrRow pr={makePr({ review_decision: 'dismissed' })} />);
    expect(screen.getByText('dismissed')).toBeTruthy();
  });
});

describe('PrRow — trust badge gating', () => {
  it('shows the "trusted" badge only when trusted AND reviewerRoleEnabled', () => {
    render(<PrRow pr={makePr({ trusted: true, reviewerRoleEnabled: true })} />);
    expect(screen.getByText('trusted')).toBeTruthy();
  });

  it('hides the "trusted" badge when reviewerRoleEnabled is false', () => {
    render(<PrRow pr={makePr({ trusted: true, reviewerRoleEnabled: false })} />);
    expect(screen.queryByText('trusted')).toBeNull();
  });

  it('hides the "trusted" badge when not trusted', () => {
    render(<PrRow pr={makePr({ trusted: false, reviewerRoleEnabled: true })} />);
    expect(screen.queryByText('trusted')).toBeNull();
  });
});

describe('PrRow — action buttons + callbacks', () => {
  it('renders Approve / Approve+merge only when reviewerRoleEnabled AND state is open', () => {
    render(<PrRow pr={makePr({ reviewerRoleEnabled: true, state: 'open' })} />);
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Approve + merge')).toBeTruthy();
  });

  it('hides actions when reviewerRoleEnabled is false', () => {
    render(<PrRow pr={makePr({ reviewerRoleEnabled: false, state: 'open' })} />);
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Approve + merge')).toBeNull();
  });

  it('hides actions when state is not open (e.g. merged)', () => {
    render(<PrRow pr={makePr({ reviewerRoleEnabled: true, state: 'merged' })} />);
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Approve + merge')).toBeNull();
  });

  it('fires onApprove and onApproveAndMerge with the PR number', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onApproveAndMerge = vi.fn();
    render(
      <PrRow
        pr={makePr({ number: 99, reviewerRoleEnabled: true, state: 'open' })}
        onApprove={onApprove}
        onApproveAndMerge={onApproveAndMerge}
      />,
    );
    await user.click(screen.getByText('Approve'));
    await user.click(screen.getByText('Approve + merge'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(99);
    expect(onApproveAndMerge).toHaveBeenCalledTimes(1);
    expect(onApproveAndMerge).toHaveBeenCalledWith(99);
  });
});

describe('PrRow — gone (404-demoted) state', () => {
  it('renders the "PR gone" tag and suppresses action buttons even with reviewerRoleEnabled', () => {
    render(<PrRow pr={makePr({ state: 'gone', reviewerRoleEnabled: true })} />);
    expect(screen.getByText('PR gone')).toBeTruthy();
    // state !== 'open' so action buttons are gated out.
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Approve + merge')).toBeNull();
  });

  it('does not show "PR gone" for a normal open PR', () => {
    render(<PrRow pr={makePr({ state: 'open' })} />);
    expect(screen.queryByText('PR gone')).toBeNull();
  });
});

// ── PR-3: agent report + WI + honest auto-status ──────────────────────

function makeReport(overrides: Partial<NonNullable<PrRowData['report']>> = {}): NonNullable<PrRowData['report']> {
  return {
    recommendation: 'approve',
    summary: 'Adds the widget and a test.',
    rationale: 'Change is scoped and tested.',
    risks: [],
    checksObserved: { checks_state: 'success', mergeable_state: 'mergeable', tests_touched: true } as never,
    headSha: 'abcdef1234',
    stale: false,
    model: 'claude',
    reviewedAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('PrRow — agent report (PR-3)', () => {
  it('renders the recommendation chip prominently', () => {
    render(<PrRow pr={makePr({ report: makeReport({ recommendation: 'approve' }) })} />);
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  it('shows request-changes / reject recommendations', () => {
    cleanup();
    render(<PrRow pr={makePr({ report: makeReport({ recommendation: 'request_changes' }) })} />);
    expect(screen.getByText('Request changes')).toBeTruthy();
    cleanup();
    render(<PrRow pr={makePr({ report: makeReport({ recommendation: 'reject' }) })} />);
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('renders the linked WI chip', () => {
    render(<PrRow pr={makePr({ featureId: 'WI-123' })} />);
    expect(screen.getByText('WI-123')).toBeTruthy();
  });

  it('flags a stale report (reviewed an earlier commit)', () => {
    render(<PrRow pr={makePr({ report: makeReport({ stale: true }) })} />);
    expect(screen.getByText('reviewed earlier commit')).toBeTruthy();
  });

  it('an expand chevron toggles the report panel', async () => {
    const user = userEvent.setup();
    const onToggleExpand = vi.fn();
    render(
      <PrRow
        pr={makePr({ number: 7, report: makeReport() })}
        expanded={false}
        onToggleExpand={onToggleExpand}
      />,
    );
    await user.click(screen.getByLabelText('Expand report for PR #7'));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('expanded → renders summary, rationale, and risks', () => {
    render(
      <PrRow
        pr={makePr({ report: makeReport({ risks: ['Touches no tests', 'Wide blast radius'] }) })}
        expanded
      />,
    );
    expect(screen.getByText('Adds the widget and a test.')).toBeTruthy();
    expect(screen.getByText(/Change is scoped and tested\./)).toBeTruthy();
    expect(screen.getByText('Touches no tests')).toBeTruthy();
    expect(screen.getByText('Wide blast radius')).toBeTruthy();
  });

  it('no report → no chevron, no recommendation chip', () => {
    render(<PrRow pr={makePr({ report: null })} />);
    expect(screen.queryByLabelText(/Expand report/)).toBeNull();
    expect(screen.queryByText('Approve')).toBeNull(); // (no manual button either, role off)
  });
});

describe('PrRow — honest auto-status (never a false "merged")', () => {
  it('manual mode → "Manual review", no merge claim', () => {
    render(<PrRow pr={makePr()} autoStatus={{ mode: 'manual' }} />);
    expect(screen.getByText(/Manual review/)).toBeTruthy();
    expect(screen.queryByText(/auto-merge on next poll/i)).toBeNull();
  });

  it('willMerge → "Will auto-merge on next poll"', () => {
    render(<PrRow pr={makePr()} autoStatus={{ mode: 'auto', willMerge: true }} />);
    expect(screen.getByText(/Will auto-merge on next poll/)).toBeTruthy();
  });

  it('blocked → shows the HONEST blocker reason, not a merged state', () => {
    render(
      <PrRow
        pr={makePr({ check_conclusion: 'failure' })}
        autoStatus={{ mode: 'auto', willMerge: false, blockers: ['CI checks are failing'] }}
      />,
    );
    expect(screen.getByText(/Auto-merge blocked: CI checks are failing/)).toBeTruthy();
    // Honesty: the row must NEVER assert the PR is merged/approved when it isn't.
    expect(screen.queryByText(/✓ approved/)).toBeNull();
  });
});
