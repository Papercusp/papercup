/**
 * @vitest-environment jsdom
 *
 * ClaimStatusBadge — P-069a sub-acceptance tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ClaimStatusBadge } from '../ClaimStatusBadge';

afterEach(() => cleanup());

describe('ClaimStatusBadge — P-069a', () => {
  it('renders unclaimed without claimant info', () => {
    render(<ClaimStatusBadge status="unclaimed" />);
    const b = screen.getByTestId('claim-status-badge-unclaimed');
    expect(b.textContent).toBe('Unclaimed');
    expect(b.getAttribute('data-claim-status')).toBe('unclaimed');
  });

  it('renders claimed without login as bare label', () => {
    render(<ClaimStatusBadge status="claimed" />);
    expect(screen.getByTestId('claim-status-badge-claimed').textContent).toBe('Claimed');
  });

  it('renders claimed with login including @ prefix', () => {
    render(<ClaimStatusBadge status="claimed" claimantLogin="alice" />);
    const b = screen.getByTestId('claim-status-badge-claimed');
    expect(b.textContent).toContain('Claimed by');
    expect(b.textContent).toContain('@alice');
  });

  it('renders stale with no successor info', () => {
    render(<ClaimStatusBadge status="stale" />);
    expect(screen.getByTestId('claim-status-badge-stale').textContent).toBe('Stale claim');
  });

  it('renders superseded as bare label without href', () => {
    render(<ClaimStatusBadge status="superseded" />);
    expect(screen.getByTestId('claim-status-badge-superseded').textContent).toBe('Superseded');
    expect(screen.queryByTestId('claim-status-superseded-link')).toBeNull();
  });

  it('renders superseded with link when href provided', () => {
    render(<ClaimStatusBadge status="superseded" supersededByHref="/harness/successor" />);
    const link = screen.getByTestId('claim-status-superseded-link');
    expect(link.getAttribute('href')).toBe('/harness/successor');
    expect(link.textContent).toBe('(open successor)');
  });

  it('each status has a distinct tooltip', () => {
    const { container } = render(
      <>
        <ClaimStatusBadge status="unclaimed" />
        <ClaimStatusBadge status="claimed" claimantLogin="x" />
        <ClaimStatusBadge status="stale" />
        <ClaimStatusBadge status="superseded" />
      </>,
    );
    const titles = Array.from(container.querySelectorAll('[data-claim-status]'))
      .map((el) => el.getAttribute('title'));
    expect(new Set(titles).size).toBe(4);          // all distinct
    expect(titles[0]).toContain('No GitHub maintainer');
    expect(titles[1]).toContain('admin/maintain');
    expect(titles[2]).toContain('lost the GitHub permission');
    expect(titles[3]).toContain('superseded');
  });

  it('null claimantLogin is treated as no-login', () => {
    render(<ClaimStatusBadge status="claimed" claimantLogin={null} />);
    expect(screen.getByTestId('claim-status-badge-claimed').textContent).toBe('Claimed');
  });
});
