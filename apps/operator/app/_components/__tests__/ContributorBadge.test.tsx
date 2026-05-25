/**
 * @vitest-environment jsdom
 *
 * ContributorBadge — P-071 sub-acceptance tests.
 *
 * Covers:
 *   P-071a — renders tier-A/B/C/D variants with correct markers + values.
 *   P-071b — visual grouping + tooltip per tier.
 *   Privacy gate — tier-D suppressed without viewerOnly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ContributorBadge, ContributorBadgeRow } from '../ContributorBadge';

afterEach(() => cleanup());

describe('ContributorBadge — P-071', () => {
  it('tier A renders ✓ marker + value + label', () => {
    render(<ContributorBadge tier="A" value={42} label="PRs" />);
    const badge = screen.getByTestId('contributor-badge-tier-a');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('✓');
    expect(badge.textContent).toContain('42');
    expect(badge.textContent).toContain('PRs');
  });

  it('tier B renders ✓ marker + value + label', () => {
    render(<ContributorBadge tier="B" value={7} label="features" />);
    const badge = screen.getByTestId('contributor-badge-tier-b');
    expect(badge.textContent).toContain('✓');
    expect(badge.textContent).toContain('7');
  });

  it('tier C has no marker (unverified)', () => {
    render(<ContributorBadge tier="C" value={150} label="events" />);
    const badge = screen.getByTestId('contributor-badge-tier-c');
    expect(badge.textContent).not.toContain('✓');
    expect(badge.textContent).not.toContain('⏱');
    expect(badge.textContent).toContain('150');
  });

  it('tier D is suppressed without viewerOnly flag', () => {
    render(<ContributorBadge tier="D" value={1250} label="cents" />);
    expect(screen.queryByTestId('contributor-badge-tier-d')).toBeNull();
  });

  it('tier D renders with ⏱ marker when viewerOnly=true', () => {
    render(<ContributorBadge tier="D" value={1250} label="cents" viewerOnly />);
    const badge = screen.getByTestId('contributor-badge-tier-d');
    expect(badge.textContent).toContain('⏱');
    expect(badge.textContent).toContain('1250');
  });

  it('each tier sets data-tier attribute for CSS hooks', () => {
    render(<ContributorBadge tier="A" value={1} label="x" />);
    expect(screen.getByTestId('contributor-badge-tier-a').getAttribute('data-tier')).toBe('A');
  });

  it('tooltip text differs per tier', () => {
    render(
      <>
        <ContributorBadge tier="A" value={1} label="x" />
        <ContributorBadge tier="B" value={1} label="x" />
        <ContributorBadge tier="C" value={1} label="x" />
        <ContributorBadge tier="D" value={1} label="x" viewerOnly />
      </>,
    );
    const a = screen.getByTestId('contributor-badge-tier-a').getAttribute('title');
    const b = screen.getByTestId('contributor-badge-tier-b').getAttribute('title');
    const c = screen.getByTestId('contributor-badge-tier-c').getAttribute('title');
    const d = screen.getByTestId('contributor-badge-tier-d').getAttribute('title');
    expect(a).toContain('Tier A');
    expect(b).toContain('Tier B');
    expect(c).toContain('Tier C');
    expect(d).toContain('Tier D');
    // Each tooltip mentions a distinguishing word
    expect(a).toContain('GitHub API');
    expect(b).toContain('completion_ref');
    expect(c).toContain('self-asserted');
    expect(d).toContain('spend');
  });
});

describe('ContributorBadgeRow', () => {
  it('renders all three tiers in order A, B, C', () => {
    const { container } = render(
      <ContributorBadgeRow prsMerged={5} featuresShipped={2} activityEvents={87} />,
    );
    const badges = Array.from(container.querySelectorAll('[data-tier]'));
    expect(badges.map((b) => b.getAttribute('data-tier'))).toEqual(['A', 'B', 'C']);
  });

  it('does NOT include tier-D in the public row', () => {
    render(<ContributorBadgeRow prsMerged={5} featuresShipped={2} activityEvents={87} />);
    expect(screen.queryByTestId('contributor-badge-tier-d')).toBeNull();
  });

  it('zero counts still render (don\'t hide tier-A with 0 PRs)', () => {
    render(<ContributorBadgeRow prsMerged={0} featuresShipped={0} activityEvents={0} />);
    expect(screen.getByTestId('contributor-badge-tier-a')).toBeTruthy();
    expect(screen.getByTestId('contributor-badge-tier-b')).toBeTruthy();
    expect(screen.getByTestId('contributor-badge-tier-c')).toBeTruthy();
  });
});
