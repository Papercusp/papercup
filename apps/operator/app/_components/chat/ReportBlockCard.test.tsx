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
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(() => cleanup());

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
});
