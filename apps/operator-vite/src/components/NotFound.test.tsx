// @vitest-environment jsdom
/**
 * NotFound render coverage — the root notFoundComponent (ported from
 * apps/operator/app/not-found.tsx). Mostly a presentational shell, but it
 * resolves the {cupboard} term via the lexicon and renders three CTA links;
 * this pins the headline + the three destinations and the lexicon term so a
 * lexicon or route regression is caught. Link + useLexicon are mocked (the page
 * has no router context in a unit).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string) => (term === 'cupboard' ? 'Cupboard' : term),
}));

import NotFound from './NotFound';

afterEach(() => cleanup());

describe('<NotFound>', () => {
  it('renders the headline and the labelled section', () => {
    render(<NotFound />);
    expect(screen.getByText('This page slipped past the cusp.')).toBeTruthy();
    expect(screen.getByText('Tiny detour detected')).toBeTruthy();
  });

  it('renders three CTAs to the right destinations', () => {
    render(<NotFound />);
    const mission = screen.getByText('Return to Mission Control').closest('a')!;
    expect(mission.getAttribute('href')).toBe('/adv');
    const support = screen.getByText('Ask for help').closest('a')!;
    expect(support.getAttribute('href')).toBe('/support');
    // The cupboard CTA threads the lexicon term into its label.
    const cupboard = screen.getByText(/Browse the/).closest('a')!;
    expect(cupboard.getAttribute('href')).toBe('/cupboard');
    expect(cupboard.textContent).toContain('Cupboard');
  });
});
