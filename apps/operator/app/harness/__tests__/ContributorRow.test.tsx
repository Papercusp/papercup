/**
 * @vitest-environment jsdom
 *
 * ContributorRow — P-048a sub-acceptance tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ContributorRow, type ContributorRowData } from '../ContributorRow';

afterEach(() => cleanup());

function row(overrides: Partial<ContributorRowData> = {}): ContributorRowData {
  return {
    github_user_id: 7654321,
    github_username: 'alice',
    display_name: 'Alice Example',
    avatar_url: null,
    joined_at: Date.parse('2026-04-01T00:00:00Z'),
    last_seen_at: null,
    binding_status: 'verified',
    binding_last_checked_at: null,
    device_count: 1,
    prs_merged: 3,
    features_shipped: 2,
    activity_events: 11,
    ...overrides,
  };
}

describe('ContributorRow — P-048a', () => {
  it('renders display name, username, and avatar-link target', () => {
    render(<ContributorRow row={row()} />);
    expect(screen.getByText('Alice Example')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    const link = screen.getByLabelText('Profile for Alice Example') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/users/github/7654321');
  });

  it('falls back to github_username when display_name is null', () => {
    render(<ContributorRow row={row({ display_name: null })} />);
    const link = screen.getByLabelText('Profile for alice') as HTMLAnchorElement;
    expect(link).toBeTruthy();
  });

  it('renders ContributorBadgeRow with stats (tier A/B/C)', () => {
    const { container } = render(<ContributorRow row={row()} />);
    expect(container.textContent).toContain('3'); // prs_merged
    expect(container.textContent).toContain('2'); // features_shipped
    expect(container.textContent).toContain('11'); // activity_events
  });

  it('binding_status pending renders pending badge with age text', () => {
    const recent = Date.now() - 6 * 3600 * 1000;
    const { container } = render(
      <ContributorRow row={row({ binding_status: 'pending', joined_at: recent })} />,
    );
    expect(container.textContent).toContain('⏳');
  });

  it('binding_status unverified greys-out + zeros stats', () => {
    const { container } = render(
      <ContributorRow row={row({ binding_status: 'unverified', prs_merged: 99 })} />,
    );
    const rowEl = container.querySelector('[data-binding-status="unverified"]') as HTMLElement;
    expect(rowEl).toBeTruthy();
    expect(rowEl.style.opacity).toBe('0.55');
    // The 99 PR count is suppressed; only zero values remain.
    expect(rowEl.textContent).not.toContain('99');
  });

  it('device_count plural / singular text', () => {
    const single = render(<ContributorRow row={row({ device_count: 1 })} />);
    expect(single.container.textContent).toContain('1 device');
    cleanup();
    const multi = render(<ContributorRow row={row({ device_count: 3 })} />);
    expect(multi.container.textContent).toContain('3 devices');
  });

  it('device_count 0 → no device text', () => {
    const { container } = render(<ContributorRow row={row({ device_count: 0 })} />);
    expect(container.textContent).not.toContain('device');
  });
});
