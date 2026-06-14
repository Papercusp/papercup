// @vitest-environment jsdom
/**
 * Tests for <AuthorBadge> — the plan ownership/attribution badge
 * (shared-hive-collaboration-2026-06-14 P-001, B1). Pure presentational:
 * renders a resolved identity as avatar (github img / initials chip) + handle,
 * with human vs agent treatment and a github-verified ✓.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AuthorBadge, type AuthorIdentity } from './AuthorBadge';

afterEach(cleanup);

const human: AuthorIdentity = { id: '42', handle: 'aviynw2', avatarUrl: 'https://a/42.png', kind: 'human', verified: true };
const humanNoAvatar: AuthorIdentity = { id: 'x', handle: 'stranger', avatarUrl: null, kind: 'human', verified: false };
const agent: AuthorIdentity = { id: 'su-88991fc5', handle: 'su-88991fc5', avatarUrl: null, kind: 'agent', verified: false };

describe('<AuthorBadge>', () => {
  it('renders nothing for a null/undefined identity', () => {
    const { container } = render(<AuthorBadge identity={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a github avatar img + handle + verified ✓ for a verified human', () => {
    render(<AuthorBadge identity={human} prefix="owner" />);
    const badge = screen.getByTestId('author-badge');
    expect(badge.getAttribute('data-kind')).toBe('human');
    expect(badge.getAttribute('data-verified')).toBe('true');
    expect(screen.getByText('aviynw2')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    const img = badge.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://a/42.png');
    expect(badge.textContent).toContain('✓');
  });

  it('renders an initials chip (no img) + no ✓ for an unverified human', () => {
    render(<AuthorBadge identity={humanNoAvatar} />);
    const badge = screen.getByTestId('author-badge');
    expect(badge.querySelector('img')).toBeNull();
    expect(badge.getAttribute('data-verified')).toBe('false');
    expect(badge.textContent).not.toContain('✓');
    expect(screen.getByText('stranger')).toBeTruthy();
    // initial of the handle
    expect(badge.textContent).toContain('S');
  });

  it('renders an agent chip (glyph, no avatar) with data-kind=agent', () => {
    render(<AuthorBadge identity={agent} prefix="edited by" />);
    const badge = screen.getByTestId('author-badge');
    expect(badge.getAttribute('data-kind')).toBe('agent');
    expect(badge.querySelector('img')).toBeNull();
    expect(badge.textContent).toContain('⚙');
    expect(screen.getByText('su-88991fc5')).toBeTruthy();
  });

  it('compact variant hides the handle + prefix (avatar only)', () => {
    render(<AuthorBadge identity={human} prefix="by" variant="compact" />);
    const badge = screen.getByTestId('author-badge');
    expect(screen.queryByText('aviynw2')).toBeNull();
    expect(screen.queryByText('by')).toBeNull();
    // avatar still present
    expect(badge.querySelector('img')).toBeTruthy();
  });
});
