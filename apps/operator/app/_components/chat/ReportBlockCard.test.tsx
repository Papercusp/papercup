// @vitest-environment jsdom
/**
 * ReportBlockCard component tests — renders the shared ReportBlock
 * (two-tier plan→item) as a card body. The same renderer serves the
 * Inbox detail pane (operator-report attention items) and any
 * CardSpec.report body inside AskChoiceCard.
 *
 * Plan: report-cards-inbox-reconciliation-2026-06-05 (P-006; formerly
 * structured-report-protocol P-007's OperatorReportCard test).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

afterEach(() => cleanup());

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: [],
    loading: false,
    fetching: false,
    transport: 'sse' as const,
    invalidate: () => {},
    error: null,
  }),
}));

import { ReportBlockCard } from './ReportBlockCard';
import type { ReportBlock } from '@papercusp/chat-protocol';

const report: ReportBlock = {
  title: 'Fleet status',
  plans: [
    {
      slug: 'rate-limit-layer-v2',
      title: 'Rate-limit v2',
      status: 'active',
      summary: 'top half of the layer',
      items: [
        { id: 'P-001', text: 'Error classifier', status: 'done' },
        { id: 'P-003', text: 'Per-call pacing', status: 'wip' },
      ],
    },
    { title: 'Header-only plan', status: 'blocked' },
  ],
};

describe('ReportBlockCard', () => {
  it('renders the title, plan titles, statuses, summary, and item rows', () => {
    render(<ReportBlockCard report={report} />);
    expect(screen.getByText('Fleet status')).toBeTruthy();
    expect(screen.getByText('Rate-limit v2')).toBeTruthy();
    expect(screen.getByText('top half of the layer')).toBeTruthy();
    expect(screen.getByText('Error classifier')).toBeTruthy();
    expect(screen.getByText('Per-call pacing')).toBeTruthy();
    expect(screen.getByText('P-001')).toBeTruthy();
    // A header-only plan (no items) still renders its title.
    expect(screen.getByText('Header-only plan')).toBeTruthy();
  });

  it('maps known statuses to a tone (glyph data-tone)', () => {
    const { container } = render(<ReportBlockCard report={report} />);
    // done → good tone, wip → accent tone somewhere in the tree.
    expect(container.querySelector('.report-block-glyph[data-tone="good"]')).toBeTruthy();
    expect(container.querySelector('.report-block-glyph[data-tone="accent"]')).toBeTruthy();
    expect(container.querySelector('.report-block-glyph[data-tone="bad"]')).toBeTruthy();
  });

  it('renders nothing when there are no plans', () => {
    const { container } = render(<ReportBlockCard report={{ plans: [] }} />);
    expect(container.querySelector('.report-block-card')).toBeNull();
  });

  // deterministic-status-cards-2026-07-17 P-003/D-004: the curator card's
  // actionable drill-in — the row `ref` renders as a real button.
  const curatorCard: ReportBlock = {
    plans: [
      {
        title: 'Fleet status',
        items: [
          { text: '**Blocked** [infra-liveness] — no bees running', status: 'blocked', ref: 'escalation:e1' },
          { text: 'a row with no ref', status: 'wip' },
        ],
      },
    ],
  };

  it('renders a drill-in button for a row with a ref when onDrillIn is provided, and fires it with the ref', () => {
    const onDrillIn = vi.fn();
    render(<ReportBlockCard report={curatorCard} onDrillIn={onDrillIn} />);
    const btn = screen.getByRole('button', { name: /open/i });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onDrillIn).toHaveBeenCalledWith('escalation:e1');
  });

  it('renders item markdown instead of exposing the producer syntax', () => {
    const { container } = render(<ReportBlockCard report={curatorCard} />);
    const itemText = container.querySelector('.report-block-item-text');
    expect(itemText?.querySelector('strong')?.textContent).toBe('Blocked');
    expect(itemText?.textContent).toContain('Blocked');
    expect(itemText?.textContent).not.toContain('**');
  });

  it('uses the existing work-ref markdown plugin and hydrated pill renderer', () => {
    const refReport: ReportBlock = {
      plans: [{ title: 'Refs', items: [{ text: 'See WI-37945 and P-003', status: 'wip' }] }],
    };
    render(<ReportBlockCard report={refReport} harnessSlug="papercusp" planSlug="nonp2p-bug-drain-2026-08-08" />);
    expect(screen.getByLabelText('WI-37945')).toBeTruthy();
    expect(screen.getByLabelText('P-003')).toBeTruthy();
  });

  it('renders NO drill-in for a row without a ref (only the ref row gets a button)', () => {
    const onDrillIn = vi.fn();
    const { container } = render(<ReportBlockCard report={curatorCard} onDrillIn={onDrillIn} />);
    // exactly one drill button (the ref row), not one per row.
    expect(container.querySelectorAll('.report-block-item-drill')).toHaveLength(1);
  });

  it('renders inert (no buttons) when onDrillIn is omitted — the inbox/report uses are unchanged', () => {
    const { container } = render(<ReportBlockCard report={curatorCard} />);
    expect(container.querySelector('.report-block-item-drill')).toBeNull();
  });
});
