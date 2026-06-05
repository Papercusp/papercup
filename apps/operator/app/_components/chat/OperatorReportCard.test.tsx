// @vitest-environment jsdom
/**
 * OperatorReportCard component tests — renders the structured <report>
 * payload as a two-tier plan→item card.
 *
 * Plan: structured-report-protocol-2026-06-05 (P-007).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(() => cleanup());

import { OperatorReportCard } from './OperatorReportCard';
import type { ParsedReport } from '@papercusp/operator-core/lib/operator-converse-tags';

const report: ParsedReport = {
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

describe('OperatorReportCard', () => {
  it('renders the title, plan titles, statuses, summary, and item rows', () => {
    render(<OperatorReportCard report={report} />);
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
    const { container } = render(<OperatorReportCard report={report} />);
    // done → good tone, wip → accent tone somewhere in the tree.
    expect(container.querySelector('.operator-report-glyph[data-tone="good"]')).toBeTruthy();
    expect(container.querySelector('.operator-report-glyph[data-tone="accent"]')).toBeTruthy();
    expect(container.querySelector('.operator-report-glyph[data-tone="bad"]')).toBeTruthy();
  });

  it('renders nothing when there are no plans', () => {
    const { container } = render(<OperatorReportCard report={{ plans: [] }} />);
    expect(container.querySelector('.operator-report-card')).toBeNull();
  });
});
