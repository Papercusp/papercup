/**
 * @vitest-environment jsdom
 *
 * UserProfile shell — P-072a/b/c/d render tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UserProfile, type UserProfileData } from '../UserProfile';

afterEach(() => cleanup());

function data(over: Partial<UserProfileData> = {}): UserProfileData {
  return {
    github_user_id: 12345,
    github_login: 'alice',
    display_name: 'Alice Example',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
    binding_status: 'verified',
    harnesses: [
      {
        harness_slug: 'sheets',
        display_title: 'Sheets',
        href: '/harness/sheets',
        prs_merged: 7,
        features_shipped: 3,
        activity_events: 42,
      },
    ],
    recent_activity: [
      { id: 'e1', ts: Date.now() - 3600_000, kind: 'feature_shipped', label: 'Shipped F-042 in sheets', href: '/harness/sheets' },
      { id: 'e2', ts: Date.now() - 86400_000, kind: 'pr_merged', label: 'Merged PR #99 in sheets' },
    ],
    claimed_harnesses: [
      { harness_slug: 'sheets', display_title: 'Sheets', href: '/harness/sheets', claim_status: 'claimed' },
    ],
    ...over,
  };
}

describe('UserProfile — P-072', () => {
  it('P-072a header renders display_name + @login + binding badge + GH link', () => {
    render(<UserProfile data={data()} />);
    expect(screen.getByText('Alice Example')).toBeTruthy();
    expect(screen.getByTestId('binding-status-badge-verified')).toBeTruthy();
    // @alice appears in both the header link and the claimed-harness badge;
    // assert that the header link exists with the right href.
    const links = screen.getAllByText('@alice');
    const ghLink = links.find((el) => el.closest('a')?.getAttribute('href') === 'https://github.com/alice');
    expect(ghLink).toBeTruthy();
  });

  it('header falls back to login when display_name is null', () => {
    render(<UserProfile data={data({ display_name: null })} />);
    // h1 should contain the login when no display_name
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('alice');
  });

  it('P-072b harnesses section renders one block per harness with the badge row', () => {
    render(<UserProfile data={data()} />);
    const section = screen.getByTestId('profile-section-harnesses');
    expect(section.textContent).toContain('Sheets');
    // The 3 trust-tier badges should show up via ContributorBadgeRow.
    expect(section.querySelectorAll('[data-tier]').length).toBe(3);
  });

  it('P-072b empty harnesses shows the empty-state copy', () => {
    render(<UserProfile data={data({ harnesses: [] })} />);
    expect(screen.getByText(/No visible hives/)).toBeTruthy();
  });

  it('P-072c recent activity renders entries with time-ago labels', () => {
    render(<UserProfile data={data()} />);
    const section = screen.getByTestId('profile-section-activity');
    expect(section.textContent).toContain('Shipped F-042');
    expect(section.textContent).toContain('Merged PR #99');
    // Time-ago format should be present.
    expect(/h ago|d ago|just now/.test(section.textContent ?? '')).toBe(true);
  });

  it('P-072c empty activity shows the empty-state copy', () => {
    render(<UserProfile data={data({ recent_activity: [] })} />);
    expect(screen.getByText(/No recent activity/)).toBeTruthy();
  });

  it('P-072d claimed-harnesses footer renders when non-empty, with ClaimStatusBadge', () => {
    render(<UserProfile data={data()} />);
    expect(screen.getByTestId('profile-section-claimed')).toBeTruthy();
    expect(screen.getByTestId('claim-status-badge-claimed')).toBeTruthy();
  });

  it('P-072d claimed-harnesses footer is omitted when empty', () => {
    render(<UserProfile data={data({ claimed_harnesses: [] })} />);
    expect(screen.queryByTestId('profile-section-claimed')).toBeNull();
  });

  it('avatar omitted when avatar_url is null', () => {
    const { container } = render(<UserProfile data={data({ avatar_url: null })} />);
    expect(container.querySelectorAll('img').length).toBe(0);
  });

  it('recent_activity is capped at 30 entries', () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`, ts: Date.now() - i * 60_000, kind: 'x', label: `event ${i}`,
    }));
    render(<UserProfile data={data({ recent_activity: events })} />);
    const section = screen.getByTestId('profile-section-activity');
    // Each entry is a div child of the section after the title div.
    // Count "event N" substrings.
    const matches = (section.textContent ?? '').match(/event \d+/g) ?? [];
    expect(matches.length).toBe(30);
  });
});
